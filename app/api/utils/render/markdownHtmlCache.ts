import { createHash } from 'crypto'
import type { KunSafeHtml } from '~/types/content'
import {
  MARKDOWN_HTML_CACHE_DURATION,
  MARKDOWN_HTML_CACHE_MAX_HTML_BYTES,
  MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES
} from '~/config/cache'

type MarkdownHtmlCacheVariant =
  'standard' | 'extend' | 'comment' | `comment-v${number}` | `extend-v${number}`
type MarkdownHtmlRenderer = () => Promise<string>
type MarkdownHtmlCacheOptions = {
  enabled?: boolean
  ttlSeconds?: number
  maxMarkdownBytes?: number
  maxHtmlBytes?: number
}

const MARKDOWN_HTML_CACHE_KEY = 'markdown:html'
const MARKDOWN_HTML_CACHE_VERSION = 'v3'
const MARKDOWN_HTML_CACHE_TIMEOUT_MS = 200
const MARKDOWN_HTML_CACHE_RETRY_DELAY_MS = 30 * 1000
const MARKDOWN_HTML_RENDER_TIMEOUT_MS = 10 * 1000

let markdownHtmlCacheDisabledUntil = 0

const inFlightRenders = new Map<string, Promise<string>>()

const isRedisConfigured = () =>
  Boolean(process.env.REDIS_HOST && process.env.REDIS_PORT)

const isMarkdownHtmlCacheAvailable = () =>
  isRedisConfigured() && Date.now() >= markdownHtmlCacheDisabledUntil

const disableMarkdownHtmlCache = () => {
  markdownHtmlCacheDisabledUntil =
    Date.now() + MARKDOWN_HTML_CACHE_RETRY_DELAY_MS
}

const isWithinByteLimit = (value: string, maxBytes: number) =>
  Buffer.byteLength(value, 'utf8') <= maxBytes

const OVERSIZED_FALLBACK_PREVIEW_CHARS = 20000

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

// 超出渲染字节上限的文档若照常走同步 unified 渲染会阻塞事件循环
// （实测 __tests__/markdownRenderBlocking.test.ts blockingRatio≈1.00），改为 O(n) 的
// 转义纯文本预览 + 截断提示。写入侧 validations/edit.ts 已阻止新内容超限，此处兜底
// 历史遗留或越过写入校验的超大数据。
const buildOversizedMarkdownFallback = (markdown: string) =>
  `<p>${escapeHtml(markdown.slice(0, OVERSIZED_FALLBACK_PREVIEW_CHARS))}</p>\n<p>内容体积过大，已截断为纯文本显示。</p>`

const getMarkdownHtmlCacheKey = (
  variant: MarkdownHtmlCacheVariant,
  markdown: string
) => {
  const hash = createHash('sha256').update(markdown).digest('hex')
  return `${MARKDOWN_HTML_CACHE_KEY}:${MARKDOWN_HTML_CACHE_VERSION}:${variant}:${hash}`
}

const withCacheTimeout = async <T>(operation: Promise<T>, fallback: T) => {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => {
          disableMarkdownHtmlCache()
          resolve(fallback)
        }, MARKDOWN_HTML_CACHE_TIMEOUT_MS)
      })
    ])
  } catch {
    disableMarkdownHtmlCache()
    return fallback
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

const readMarkdownHtmlCache = async (cacheKey: string) => {
  if (!isMarkdownHtmlCacheAvailable()) {
    return null
  }

  return withCacheTimeout(
    (async () => {
      const { getKv } = await import('~/lib/redis')
      return await getKv(cacheKey)
    })(),
    null
  )
}

const deleteMarkdownHtmlCache = async (cacheKey: string) => {
  if (!isMarkdownHtmlCacheAvailable()) {
    return
  }

  await withCacheTimeout(
    (async () => {
      const { delKv } = await import('~/lib/redis')
      await delKv(cacheKey)
    })(),
    undefined
  )
}

// 注意：Promise.race 无法中断同步 CPU 渲染。unified().process() 同步执行
// （实测见 __tests__/markdownRenderBlocking.test.ts），其间事件循环被占满，下方
// setTimeout 要等渲染结束才能触发，reject 分支对同步渲染是死代码——此超时仅对真正
// 让出事件循环的异步 renderer 有意义。同步阻塞的封顶由输入侧字节上限降级负责。
const renderWithTimeout = async (
  render: MarkdownHtmlRenderer
): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      render(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('markdown html render timed out'))
        }, MARKDOWN_HTML_RENDER_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

const writeMarkdownHtmlCache = async (
  cacheKey: string,
  html: string,
  ttlSeconds: number
) => {
  if (!isMarkdownHtmlCacheAvailable()) {
    return
  }

  await withCacheTimeout(
    (async () => {
      const { setKv } = await import('~/lib/redis')
      await setKv(cacheKey, html, ttlSeconds)
    })(),
    undefined
  )
}

const renderMarkdownHtml = async (
  variant: MarkdownHtmlCacheVariant,
  markdown: string,
  render: MarkdownHtmlRenderer,
  options: MarkdownHtmlCacheOptions = {}
) => {
  const {
    enabled = true,
    ttlSeconds = MARKDOWN_HTML_CACHE_DURATION,
    maxMarkdownBytes = MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES,
    maxHtmlBytes = MARKDOWN_HTML_CACHE_MAX_HTML_BYTES
  } = options

  if (!isWithinByteLimit(markdown, maxMarkdownBytes)) {
    return buildOversizedMarkdownFallback(markdown)
  }

  if (!enabled || ttlSeconds <= 0) {
    return renderWithTimeout(render)
  }

  const cacheKey = getMarkdownHtmlCacheKey(variant, markdown)

  const existing = inFlightRenders.get(cacheKey)
  if (existing) {
    return existing
  }

  const pending = (async () => {
    const cachedHtml = await readMarkdownHtmlCache(cacheKey)

    if (cachedHtml !== null) {
      if (isWithinByteLimit(cachedHtml, maxHtmlBytes)) {
        return cachedHtml
      }

      await deleteMarkdownHtmlCache(cacheKey)
    }

    const html = await renderWithTimeout(render)
    if (isWithinByteLimit(html, maxHtmlBytes)) {
      await writeMarkdownHtmlCache(cacheKey, html, ttlSeconds)
    }

    return html
  })()

  inFlightRenders.set(cacheKey, pending)

  try {
    return await pending
  } finally {
    inFlightRenders.delete(cacheKey)
  }
}

// KunSafeHtml 品牌从这里发出。三条返回路径都是已净化 HTML: 渲染器由本目录的三条 markdown
// 管线提供, 都以 rehypeSanitize 收尾; 超限降级输出的是转义后的纯文本; 缓存里存的是此前
// 同一批渲染器的产物 (Redis 回读属于隐式信任)
export const renderMarkdownHtmlWithCache = async (
  ...args: Parameters<typeof renderMarkdownHtml>
): Promise<KunSafeHtml> => (await renderMarkdownHtml(...args)) as KunSafeHtml
