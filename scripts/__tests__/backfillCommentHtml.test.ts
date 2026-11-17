import { afterEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, updateManyMock, disconnectMock, getKvMock } = vi.hoisted(
  () => ({
    findManyMock: vi.fn(),
    updateManyMock: vi.fn(),
    disconnectMock: vi.fn(),
    getKvMock: vi.fn()
  })
)

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findMany: findManyMock, updateMany: updateManyMock },
    $disconnect: disconnectMock
  }
}))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: vi.fn(),
  delKv: vi.fn()
}))

import { getKunMarkdownProcessor } from '~/app/api/utils/render/processor'
import { KUN_MARKDOWN_PROFILES } from '~/app/api/utils/render/profiles'

const COMMENT_HTML_VERSION = KUN_MARKDOWN_PROFILES.comment.version
const markdownCommentProcessor = getKunMarkdownProcessor('comment')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('backfillCommentHtml', () => {
  // P14-03: 回填曾按 id 无条件写回, 回填期间被编辑的评论会被写成旧正文的 HTML 并标成
  // 当前版本, 之后不再自愈。现在与评论分页的读时自愈共用同一份带 CAS 的写回
  it('写回带版本与 updated 条件; 渲染缺陷的行不写回; 渲染不经缓存', async () => {
    // 即使配了 Redis 也不碰: 脚本一旦连上 redis 进程就退不出来
    vi.stubEnv('REDIS_HOST', '127.0.0.1')
    vi.stubEnv('REDIS_PORT', '6379')
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {})
    const parse = markdownCommentProcessor.parse.bind(markdownCommentProcessor)
    vi.spyOn(markdownCommentProcessor, 'parse').mockImplementation((doc) => {
      if (String(doc).includes('BROKEN')) {
        throw new Error('boom')
      }
      return parse(doc)
    })
    const updated = new Date('2026-01-01T00:00:00.000Z')
    const stale = {
      content_html: '<p>old</p>',
      content_html_version: COMMENT_HTML_VERSION - 1,
      updated
    }
    findManyMock
      .mockResolvedValueOnce([
        { ...stale, id: 7, content: '**hi**' },
        { ...stale, id: 8, content: 'BROKEN' }
      ])
      .mockResolvedValueOnce([])
    updateManyMock.mockResolvedValue({ count: 1 })
    disconnectMock.mockResolvedValue(undefined)

    await import('~/scripts/backfillCommentHtml')
    await vi.waitFor(() => expect(disconnectMock).toHaveBeenCalled())

    expect(findManyMock.mock.calls[0][0]).toMatchObject({
      where: { content_html_version: { not: COMMENT_HTML_VERSION } },
      select: { updated: true }
    })
    expect(updateManyMock).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: 7,
        content_html_version: { not: COMMENT_HTML_VERSION },
        updated
      },
      data: {
        content_html: '<p><strong>hi</strong></p>',
        content_html_version: COMMENT_HTML_VERSION
      }
    })
    // 渲染不出来的行不挡住游标, 只计数并报出 id
    expect(findManyMock.mock.calls[1][0].where.id).toEqual({ gt: 8 })
    expect(errored).toHaveBeenCalledWith(
      '[backfill] comment 8 failed to render'
    )
    expect(logged).toHaveBeenLastCalledWith(
      '[backfill] complete. total processed=1, skipped=0, failed=1'
    )
    expect(getKvMock).not.toHaveBeenCalled()
  })
})
