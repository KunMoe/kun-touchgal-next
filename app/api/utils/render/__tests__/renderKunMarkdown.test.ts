import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { kvStore, getKvMock, setKvMock, delKvMock } = vi.hoisted(() => {
  const kvStore = new Map<string, string>()
  return {
    kvStore,
    getKvMock: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    setKvMock: vi.fn(async (key: string, value: string, _ttl?: number) => {
      kvStore.set(key, value)
    }),
    delKvMock: vi.fn(async (key: string) => {
      kvStore.delete(key)
    })
  }
})

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock,
  delKv: delKvMock
}))

import {
  MARKDOWN_HTML_CACHE_DURATION,
  MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES,
  MARKDOWN_RENDER_ERROR_CACHE_DURATION
} from '~/config/cache'
import {
  NOTE_HTML_VERSION,
  PATCH_INTRODUCTION_HTML_VERSION
} from '~/app/api/utils/render/htmlVersion'
import { markdownProcessor } from '~/app/api/utils/render/markdownToHtml'
import {
  COMMENT_HTML_VERSION,
  markdownCommentProcessor
} from '~/app/api/utils/render/markdownToHtmlComment'
import { markdownExtendProcessor } from '~/app/api/utils/render/markdownToHtmlExtend'
import {
  renderKunMarkdown,
  renderKunMarkdownForWrite
} from '~/app/api/utils/render/renderKunMarkdown'
import type { KunMarkdownProfile } from '~/app/api/utils/render/renderKunMarkdown'

const PROFILES = [
  ['comment', markdownCommentProcessor, COMMENT_HTML_VERSION],
  ['note', markdownProcessor, NOTE_HTML_VERSION],
  ['introduction', markdownExtendProcessor, PATCH_INTRODUCTION_HTML_VERSION]
] as const

const enableCache = () => {
  vi.stubEnv('REDIS_HOST', '127.0.0.1')
  vi.stubEnv('REDIS_PORT', '6379')
}

// 默认不配 Redis: 渲染不经缓存, 需要缓存的用例自己打开
beforeEach(() => {
  vi.stubEnv('REDIS_HOST', '')
  vi.stubEnv('REDIS_PORT', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  kvStore.clear()
})

describe.each(PROFILES)(
  'renderKunMarkdown(%s)',
  (profile, processor, version) => {
    // 入口把 process() 拆成 parse / run / stringify 以便中途检查结构, 输出不能因此改变
    it.each([
      [
        '常规嵌套',
        '> quote\n>> deeper\n\n- a\n  - b\n    1. c\n\n**bold _em `code`_** ~~del~~ www.a.example'
      ],
      ['表格', '| a | b |\n| - | - |\n| 1 | 2 |'],
      ['代码块', '```js {1-3}\nconst a = 1\n```'],
      [
        '链接与图片',
        '[站内](/doc) [外链](https://a.example/x?y=1) ![图](https://a.example/a.png "标题")'
      ],
      ['内嵌 HTML 与实体', '<b>x</b> &amp; &#35; <script>alert(1)</script>'],
      [
        '指令',
        '::kun-link{href="https://a.example" text="a"}\n\n:::note\n内容\n:::\n\n10:30 开播'
      ],
      ['空串', '']
    ])('%s的输出与 processor.process() 逐字节一致', async (_name, markdown) => {
      const result = await renderKunMarkdown(profile, markdown)

      expect(result).toEqual({
        ok: true,
        html: String(await processor.process(markdown)),
        version
      })
    })

    // P02-01: 这些输入曾让渲染抛 RangeError 或同步阻塞数秒
    it.each([
      ['引用', `${'>'.repeat(2500)}x`],
      ['无序列表', `${'- '.repeat(5003)}x`],
      ['有序列表', `${'1. '.repeat(3335)}x`],
      ['引用与列表交替', `${'> - '.repeat(2500)}x`],
      // 树只有两层, 解析却要约 1 秒: 结构上限看不到, 靠同段方括号个数熔断
      ['图片', `${'!['.repeat(1666)}x${'](u)'.repeat(1666)}`],
      ['闭括号 (一个开括号都没有) ', 'a]'.repeat(5003)]
    ])('深层嵌套的%s不解析, 降级为转义纯文本', async (_name, markdown) => {
      const parse = vi.spyOn(processor, 'parse')

      const result = await renderKunMarkdown(profile, markdown)

      expect(parse).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        ok: false,
        reason: 'too-deep',
        version,
        persistable: true
      })
      expect(result.html).toContain('格式嵌套过多')
      expect(result.html).not.toContain('<blockquote>')
      expect(result.html).not.toContain('<li>')
    })

    // 结构上限作用在真实的 mdast 上: 126 层引用 + 段落 + 文字 = 128。
    // 改 MARKDOWN_MAX_TREE_DEPTH 会让这条失败: 那是渲染策略变更, 要递增该 profile 的版本
    it('结构上限锁在 128 层: 126 层引用放行, 127 层降级', async () => {
      const atLimit = await renderKunMarkdown(profile, `${'>'.repeat(126)} x`)
      const overLimit = await renderKunMarkdown(profile, `${'>'.repeat(127)} x`)

      expect(atLimit.ok).toBe(true)
      expect(atLimit.html.match(/<blockquote>/g)).toHaveLength(126)
      expect(overLimit).toMatchObject({
        ok: false,
        reason: 'too-deep',
        persistable: true
      })
    })

    it('超过字节上限时降级为纯文本, 不解析', async () => {
      // 每个「一」占 3 字节, 字符数取上限值即约 3 倍字节
      const oversized = '一'.repeat(MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES)
      const parse = vi.spyOn(processor, 'parse')

      const result = await renderKunMarkdown(profile, oversized)

      expect(parse).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        ok: false,
        reason: 'too-large',
        persistable: true
      })
      expect(result.html).toContain('已截断')
    })

    // 渲染缺陷不是预算的结论: 结果不可落库, 只做短 TTL 负缓存
    it('渲染中途抛错时不 reject, 给出不可落库的降级结果', async () => {
      enableCache()
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(processor, 'run').mockRejectedValue(
        new RangeError('Maximum call stack size exceeded')
      )

      const result = await renderKunMarkdown(profile, '<b>hello</b>')

      expect(result).toMatchObject({
        ok: false,
        reason: 'render-error',
        version,
        persistable: false
      })
      expect(result.html).toContain('&lt;b&gt;hello&lt;/b&gt;')
      expect(logged).toHaveBeenCalledOnce()
      expect(setKvMock).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify({ html: result.html, reason: 'render-error' }),
        MARKDOWN_RENDER_ERROR_CACHE_DURATION
      )
    })
  }
)

describe('renderKunMarkdown 残余成本', () => {
  // 深层行内强调没有便宜的预判, 要解析完才知道超限 (约 0.5 秒, 写入时付一次);
  // 重要的是它不再抛错, 也不进入按树深递归的转换阶段
  it('深层行内强调解析后按结构上限降级', async () => {
    const run = vi.spyOn(markdownCommentProcessor, 'run')

    const result = await renderKunMarkdown(
      'comment',
      `${'**'.repeat(2500)}x${'**'.repeat(2500)}`
    )

    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, reason: 'too-deep' })
  })

  it('入口自身出现意外异常时同样不 reject', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Buffer, 'byteLength').mockImplementationOnce(() => {
      throw new Error('unexpected')
    })

    await expect(renderKunMarkdown('comment', 'hello')).resolves.toMatchObject({
      ok: false,
      reason: 'render-error',
      persistable: false
    })
    expect(logged).toHaveBeenCalledOnce()
  })
})

describe('renderKunMarkdown 缓存', () => {
  beforeEach(enableCache)

  // 键只按内容 hash: 不带策略版本的话, 版本递增后仍会供出旧策略的 HTML
  it.each(PROFILES)('%s 的缓存键带该 profile 的策略版本', async (profile) => {
    await renderKunMarkdown(profile, 'hello')

    const variant = {
      comment: `comment-v${COMMENT_HTML_VERSION}`,
      note: `note-v${NOTE_HTML_VERSION}`,
      introduction: `introduction-v${PATCH_INTRODUCTION_HTML_VERSION}`
    }[profile as KunMarkdownProfile]
    expect(setKvMock).toHaveBeenCalledOnce()
    expect(setKvMock.mock.calls[0][0]).toMatch(
      new RegExp(`^markdown:html:v4:${variant}:[0-9a-f]{64}$`)
    )
  })

  it('命中缓存时不再解析', async () => {
    const parse = vi.spyOn(markdownCommentProcessor, 'parse')

    const first = await renderKunMarkdown('comment', '**hello**')
    const second = await renderKunMarkdown('comment', '**hello**')

    expect(parse).toHaveBeenCalledOnce()
    expect(setKvMock).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ html: '<p><strong>hello</strong></p>' }),
      MARKDOWN_HTML_CACHE_DURATION
    )
    expect(second).toEqual(first)
  })

  // 负缓存: 失败不被记住的话, 每次读都要重新付一遍解析成本。命中时要能还原成同一个
  // 失败结果, 否则写入口会把降级输出当成渲染成功
  it('解析后才得出的降级结果被记住, 命中时还原出原因', async () => {
    const parse = vi.spyOn(markdownCommentProcessor, 'parse')
    const markdown = `${'>'.repeat(127)} x`

    const first = await renderKunMarkdown('comment', markdown)
    const second = await renderKunMarkdown('comment', markdown)

    expect(parse).toHaveBeenCalledOnce()
    expect(setKvMock).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ html: first.html, reason: 'too-deep' }),
      MARKDOWN_HTML_CACHE_DURATION
    )
    expect(second).toEqual(first)
    expect(second).toMatchObject({
      ok: false,
      reason: 'too-deep',
      persistable: true
    })
  })

  it('不解析就能得出的降级结果不占缓存', async () => {
    await renderKunMarkdown('comment', `${'>'.repeat(2500)}x`)

    expect(getKvMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it.each([
    ['不是 JSON', '<p>旧格式的裸 HTML</p>'],
    ['缺 html 字段', JSON.stringify({ reason: 'too-deep' })],
    ['html 不是字符串', JSON.stringify({ html: 1 })]
  ])('缓存值%s时删除并重新渲染', async (_name, cached) => {
    getKvMock.mockResolvedValueOnce(cached)

    const result = await renderKunMarkdown('comment', 'hello')

    expect(delKvMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: true, html: '<p>hello</p>' })
  })

  it('缓存里出现不认识的失败原因时当作未命中', async () => {
    getKvMock.mockResolvedValueOnce(
      JSON.stringify({ html: '<p>x</p>', reason: 'from-the-future' })
    )

    const result = await renderKunMarkdown('comment', 'hello')

    expect(result).toMatchObject({ ok: true, html: '<p>hello</p>' })
  })

  it('同键的并发渲染合并成一次', async () => {
    const parse = vi.spyOn(markdownCommentProcessor, 'parse')

    const [first, second] = await Promise.all([
      renderKunMarkdown('comment', 'hello'),
      renderKunMarkdown('comment', 'hello')
    ])

    expect(parse).toHaveBeenCalledOnce()
    expect(second).toEqual(first)
  })

  it('cache: false 时不读写缓存', async () => {
    const result = await renderKunMarkdown('comment', 'hello', { cache: false })

    expect(result.ok).toBe(true)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })
})

describe('renderKunMarkdownForWrite', () => {
  it('渲染成功时给出 HTML 与策略版本', async () => {
    expect(await renderKunMarkdownForWrite('comment', '**hi**')).toEqual({
      html: '<p><strong>hi</strong></p>',
      version: COMMENT_HTML_VERSION
    })
  })

  it.each([
    [
      'comment',
      `${'>'.repeat(300)} x`,
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    ],
    [
      'note',
      `${'>'.repeat(300)} x`,
      '资源备注中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    ],
    [
      'note',
      '一'.repeat(MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES),
      '资源备注的内容过长, 请精简后再提交'
    ]
  ] as const)(
    '%s 渲染不出来时返回业务错误消息',
    async (profile, markdown, message) => {
      expect(await renderKunMarkdownForWrite(profile, markdown)).toBe(message)
    }
  )

  it('渲染缺陷同样拒绝写入', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(markdownCommentProcessor, 'parse').mockImplementation(() => {
      throw new Error('boom')
    })

    expect(await renderKunMarkdownForWrite('comment', 'hello')).toBe(
      '评论的内容暂时无法处理, 请修改后再提交'
    )
  })
})
