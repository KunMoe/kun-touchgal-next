import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { updateManyMock } = vi.hoisted(() => ({ updateManyMock: vi.fn() }))

vi.mock('~/prisma/index', () => ({
  prisma: { patch_comment: { updateMany: updateManyMock } }
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { getKunMarkdownProcessor } from '~/app/api/utils/render/processor'
import { KUN_MARKDOWN_PROFILES } from '~/app/api/utils/render/profiles'
import {
  persistCommentHtml,
  prepareCommentContent,
  readStoredCommentHtml,
  resolveCommentHtml
} from '~/app/api/patch/comment/html'

const COMMENT_HTML_VERSION = KUN_MARKDOWN_PROFILES.comment.version
const markdownCommentProcessor = getKunMarkdownProcessor('comment')

// 渲染走真实入口; 不配 Redis, 不经缓存
beforeEach(() => {
  vi.stubEnv('REDIS_HOST', '')
  vi.stubEnv('REDIS_PORT', '')
  updateManyMock.mockResolvedValue({ count: 1 })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

// 10007 字符以内、足以让旧渲染栈溢出的评论 (P02-01)
const POISON = `${'>'.repeat(2500)}x`
const updated = new Date('2026-01-01T00:00:00.000Z')

describe('readStoredCommentHtml', () => {
  it('版本与当前渲染管线一致时返回落库的 HTML', () => {
    expect(
      readStoredCommentHtml({
        content_html: '<p>comment</p>',
        content_html_version: COMMENT_HTML_VERSION
      })
    ).toBe('<p>comment</p>')
  })

  it('版本落后时返回 null, 交给调用方决定重渲染还是退回原文', () => {
    expect(
      readStoredCommentHtml({
        content_html: '<p>stale</p>',
        content_html_version: COMMENT_HTML_VERSION - 1
      })
    ).toBeNull()
  })

  // 旧写入口在渲染失败时落库为空 HTML + version 0, 这类存量行仍可能存在
  it('HTML 为空时返回 null', () => {
    expect(
      readStoredCommentHtml({
        content_html: '',
        content_html_version: COMMENT_HTML_VERSION
      })
    ).toBeNull()
    expect(
      readStoredCommentHtml({ content_html: '', content_html_version: 0 })
    ).toBeNull()
  })
})

describe('prepareCommentContent', () => {
  it('正文、派生 HTML 与当前版本一起给出', async () => {
    expect(await prepareCommentContent('**hi**')).toEqual({
      content: '**hi**',
      content_html: '<p><strong>hi</strong></p>',
      content_html_version: COMMENT_HTML_VERSION
    })
  })

  it('渲染不出来的正文返回错误消息', async () => {
    expect(await prepareCommentContent(POISON)).toBe(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
  })
})

describe('resolveCommentHtml', () => {
  const row = {
    id: 5,
    content: '**hi**',
    content_html: '<p>stored</p>',
    content_html_version: COMMENT_HTML_VERSION,
    updated
  }

  it('落库的 HTML 可信时直接用, 不渲染也不写回', async () => {
    expect(await resolveCommentHtml(row)).toEqual({
      html: '<p>stored</p>',
      heal: null
    })
  })

  it('版本落后时重渲染, 并交出写回所需的 CAS 条件', async () => {
    expect(
      await resolveCommentHtml({
        ...row,
        content_html_version: COMMENT_HTML_VERSION - 1
      })
    ).toEqual({
      html: '<p><strong>hi</strong></p>',
      heal: { id: 5, html: '<p><strong>hi</strong></p>', updated }
    })
  })

  // 超出预算是确定的结论: 降级结果按当前版本写回, 这一行此后不再重渲染
  it('渲染不出来的存量评论降级为纯文本, 降级结果同样写回', async () => {
    const { html, heal } = await resolveCommentHtml({
      ...row,
      content: POISON,
      content_html: '',
      content_html_version: 0
    })

    expect(html).toContain('格式嵌套过多')
    expect(heal).toEqual({ id: 5, html, updated })
  })

  // 没预料到的渲染缺陷可能随修复消失, 不能把降级输出固化成当前版本
  it('渲染缺陷的降级结果不写回', async () => {
    vi.spyOn(markdownCommentProcessor, 'parse').mockImplementation(() => {
      throw new Error('boom')
    })

    const { html, heal } = await resolveCommentHtml({
      ...row,
      content_html_version: 0
    })

    expect(html).toContain('暂时无法渲染')
    expect(heal).toBeNull()
  })

  // 渲染结果恰为空 (正文只有指令或 HTML 注释) 的行已是当前版本, CAS 必不命中
  it('已是当前版本但 HTML 为空的行重渲染后不发起写回', async () => {
    expect(
      await resolveCommentHtml({
        ...row,
        content: '<!-- x -->',
        content_html: ''
      })
    ).toEqual({ html: '', heal: null })
  })
})

describe('persistCommentHtml', () => {
  // 写回只收渲染入口的产物 (类型上是 KunSafeHtml), 这里经 resolveCommentHtml 取得
  const healOf = async (id: number) => {
    const { heal } = await resolveCommentHtml({
      id,
      content: 'hi',
      content_html: '',
      content_html_version: 0,
      updated
    })
    if (heal === null) {
      throw new Error('fixture should be healable')
    }
    return heal
  }

  // L-03 / P14-03: 只按 id 写回会把旧正文的 HTML 写进读出之后被编辑过的评论
  it('写回带版本与 updated 两个 CAS 条件', async () => {
    await persistCommentHtml([await healOf(5)])

    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: 5,
        content_html_version: { not: COMMENT_HTML_VERSION },
        updated
      },
      data: {
        content_html: '<p>hi</p>',
        content_html_version: COMMENT_HTML_VERSION
      }
    })
  })

  it('CAS 未命中与写入失败都计入 skipped, 不影响其余行', async () => {
    updateManyMock
      .mockResolvedValueOnce({ count: 0 })
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ count: 1 })

    const result = await persistCommentHtml(
      await Promise.all([1, 2, 3].map(healOf))
    )

    expect(result).toEqual({ written: 1, skipped: 2 })
    expect(updateManyMock).toHaveBeenCalledTimes(3)
  })
})
