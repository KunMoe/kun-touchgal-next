import {
  MARKDOWN_HTML_CACHE_DURATION,
  MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES,
  MARKDOWN_RENDER_ERROR_CACHE_DURATION
} from '~/config/cache'
import {
  MARKDOWN_MAX_TREE_DEPTH,
  exceedsCostFuse,
  treeDepthExceeds
} from './markdownBudget'
import {
  coalesceMarkdownRender,
  getMarkdownHtmlCacheKey,
  readMarkdownHtmlCache,
  writeMarkdownHtmlCache
} from './markdownHtmlCache'
import { getKunMarkdownProcessor } from './processor'
import { KUN_MARKDOWN_PROFILES } from './profiles'
import type { KunSafeHtml } from '~/types/content'
import type { KunMarkdownProfile } from './profiles'

export type { KunMarkdownProfile } from './profiles'

// 服务端 markdown → HTML 的唯一入口, 也是 KunSafeHtml 品牌在服务端渲染侧的唯一出处。
//
// 它是全函数: 任何输入都得到一个结果, 不会 reject。渲染不出来的内容由这里统一降级成
// 转义纯文本并说明原因, 调用方不需要、也不应该再各自 try/catch 后自定失败语义

// too-large / too-deep 是渲染预算的确定性结论: 同一版本下重渲染结果不变, 可以按当前
// 版本落库。render-error 是没预料到的渲染缺陷, 不落库, 只做短 TTL 负缓存
export type KunRenderFailure = 'too-large' | 'too-deep' | 'render-error'

export type KunRenderResult =
  | { ok: true; html: KunSafeHtml; version: number }
  | {
      ok: false
      reason: KunRenderFailure
      // 转义后的纯文本加一句说明, 同样可以直接展示
      html: KunSafeHtml
      version: number
      persistable: boolean
    }

const FALLBACK_PREVIEW_CHARS = 20000

const FALLBACK_NOTICE: Record<KunRenderFailure, string> = {
  'too-large': '内容体积过大，已截断为纯文本显示。',
  'too-deep': '内容中的引用、列表、方括号等格式嵌套过多，已按纯文本显示。',
  'render-error': '内容暂时无法渲染，已按纯文本显示。'
}

const PERSISTABLE: Record<KunRenderFailure, boolean> = {
  'too-large': true,
  'too-deep': true,
  'render-error': false
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

// O(n) 的转义纯文本预览。too-large 的说明本身已交代截断, 其余原因下若预览被截断再补一句
const buildPlainTextFallback = (markdown: string, reason: KunRenderFailure) => {
  const truncated =
    reason !== 'too-large' && markdown.length > FALLBACK_PREVIEW_CHARS
  return `<p>${escapeHtml(markdown.slice(0, FALLBACK_PREVIEW_CHARS))}</p>\n<p>${FALLBACK_NOTICE[reason]}${truncated ? '内容较长，仅显示开头部分。' : ''}</p>`
}

const failure = (
  profile: KunMarkdownProfile,
  markdown: string,
  reason: KunRenderFailure
): KunRenderResult => ({
  ok: false,
  reason,
  html: buildPlainTextFallback(markdown, reason) as KunSafeHtml,
  version: KUN_MARKDOWN_PROFILES[profile].version,
  persistable: PERSISTABLE[reason]
})

const logRenderError = (profile: KunMarkdownProfile, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[markdown] ${profile} render failed:`, error)
}

// unified 的 parse / run / stringify 全部同步执行 (run 只是签名异步), 这里拆开调用是
// 为了在 run 之前拿到真实的 mdast 做结构上限检查: 转换与序列化阶段按树深递归
const renderUncached = async (
  profile: KunMarkdownProfile,
  markdown: string
): Promise<KunRenderResult> => {
  const processor = getKunMarkdownProcessor(profile)
  try {
    const tree = processor.parse(markdown)
    if (treeDepthExceeds(tree, MARKDOWN_MAX_TREE_DEPTH)) {
      return failure(profile, markdown, 'too-deep')
    }
    const hast = await processor.run(tree)
    // 每个 profile 的处理器都经过 rehypeSanitize, 输出即已净化 HTML
    const html = processor.stringify(hast) as KunSafeHtml
    return { ok: true, html, version: KUN_MARKDOWN_PROFILES[profile].version }
  } catch (error) {
    logRenderError(profile, error)
    return failure(profile, markdown, 'render-error')
  }
}

// 缓存里只会有渲染成功与两种解析后才得出的失败; reason 不认识时当作未命中
const restoreCached = (
  version: number,
  cached: { html: string; reason?: string }
): KunRenderResult | null => {
  // Redis 回读属于隐式信任: 写进去的只有本文件的产物
  const html = cached.html as KunSafeHtml
  if (cached.reason === undefined) {
    return { ok: true, html, version }
  }
  if (cached.reason === 'too-deep' || cached.reason === 'render-error') {
    return {
      ok: false,
      reason: cached.reason,
      html,
      version,
      persistable: PERSISTABLE[cached.reason]
    }
  }
  return null
}

const renderCached = (profile: KunMarkdownProfile, markdown: string) => {
  const { version } = KUN_MARKDOWN_PROFILES[profile]
  const cacheKey = getMarkdownHtmlCacheKey(`${profile}-v${version}`, markdown)

  return coalesceMarkdownRender(cacheKey, async () => {
    const cached = await readMarkdownHtmlCache(cacheKey)
    const restored = cached === null ? null : restoreCached(version, cached)
    if (restored !== null) {
      return restored
    }

    const result = await renderUncached(profile, markdown)
    // 失败也记住: 否则每次读都要重新付一遍解析成本。render-error 可能随修复消失, 只短记
    await writeMarkdownHtmlCache(
      cacheKey,
      result.ok
        ? { html: result.html }
        : { html: result.html, reason: result.reason },
      !result.ok && result.reason === 'render-error'
        ? MARKDOWN_RENDER_ERROR_CACHE_DURATION
        : MARKDOWN_HTML_CACHE_DURATION
    )
    return result
  })
}

// 执行顺序: 字节上限 → 成本熔断 → 读缓存 → parse → 结构上限 → run → stringify → 写缓存。
// 前两步不解析、不碰缓存, 超限输入的处理成本与长度成正比
export const renderKunMarkdown = async (
  profile: KunMarkdownProfile,
  markdown: string,
  options: { cache?: boolean } = {}
): Promise<KunRenderResult> => {
  try {
    if (
      Buffer.byteLength(markdown, 'utf8') >
      MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES
    ) {
      return failure(profile, markdown, 'too-large')
    }
    // 不解析指令的 profile 里 `:::` 只是文本, 容器指令熔断不生效
    const directives = KUN_MARKDOWN_PROFILES[profile].directives !== 'off'
    if (exceedsCostFuse(markdown, { directives })) {
      return failure(profile, markdown, 'too-deep')
    }
    return options.cache === false
      ? await renderUncached(profile, markdown)
      : await renderCached(profile, markdown)
  } catch (error) {
    logRenderError(profile, error)
    return failure(profile, markdown, 'render-error')
  }
}

const PROFILE_LABEL: Record<KunMarkdownProfile, string> = {
  comment: '评论',
  note: '资源备注',
  introduction: '简介'
}

const WRITE_REJECTION: Record<KunRenderFailure, string> = {
  'too-large': '的内容过长, 请精简后再提交',
  'too-deep': '中的引用、列表、方括号等格式嵌套过多, 请精简后再提交',
  'render-error': '的内容暂时无法处理, 请修改后再提交'
}

// 写入口用: 渲染不出来的内容在落库前拒绝, 返回业务错误消息 (T | string 约定)
export const renderKunMarkdownForWrite = async (
  profile: KunMarkdownProfile,
  markdown: string
): Promise<{ html: KunSafeHtml; version: number } | string> => {
  const result = await renderKunMarkdown(profile, markdown)
  return result.ok
    ? { html: result.html, version: result.version }
    : `${PROFILE_LABEL[profile]}${WRITE_REJECTION[result.reason]}`
}
