import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_LOG_CONTENT_LIMIT } from '~/constants/admin'

const {
  findCommentMock,
  findAdminMock,
  transactionMock,
  updateCommentMock,
  createLogMock,
  renderMock,
  invalidateCacheMock
} = vi.hoisted(() => ({
  findCommentMock: vi.fn(),
  findAdminMock: vi.fn(),
  transactionMock: vi.fn(),
  updateCommentMock: vi.fn(),
  createLogMock: vi.fn(),
  renderMock: vi.fn(),
  invalidateCacheMock: vi.fn()
}))

const transactionClient = {
  patch_comment: { update: updateCommentMock },
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findUnique: findCommentMock },
    user: { findUnique: findAdminMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: renderMock
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: invalidateCacheMock
}))

import { updateComment } from '~/app/api/admin/comment/update'

const created = new Date('2026-01-01T00:00:00.000Z')
// content 顶到列上限, content_html 远超 admin_log.content 的 VarChar(10007)
const longContent = '评'.repeat(10007)
const longContentHtml = `<p>${'评'.repeat(60000)}</p>`

beforeEach(() => {
  vi.clearAllMocks()
  findCommentMock.mockResolvedValue({
    id: 1,
    content: longContent,
    content_html: longContentHtml,
    content_html_version: 3,
    edit: '',
    status: 0,
    user_id: 101,
    patch_id: 10,
    parent_id: null,
    created,
    updated: created
  })
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  renderMock.mockResolvedValue({ html: '<p>new</p>', version: 3 })
  updateCommentMock.mockResolvedValue({})
  createLogMock.mockResolvedValue({})
  invalidateCacheMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('updateComment', () => {
  it('logs a bounded summary instead of the full row snapshot', async () => {
    await expect(
      updateComment(
        { commentId: 1, content: 'new content', isSpoiler: false },
        99
      )
    ).resolves.toEqual({})

    expect(updateCommentMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        content: 'new content',
        content_html: '<p>new</p>',
        content_html_version: 3
      })
    })

    expect(createLogMock).toHaveBeenCalledTimes(1)
    const logContent = createLogMock.mock.calls[0][0].data.content as string
    expect(logContent.length).toBeLessThanOrEqual(ADMIN_LOG_CONTENT_LIMIT)
    expect(logContent).not.toContain('content_html')
    expect(logContent).toContain(`"contentPreview":"${'评'.repeat(100)}"`)

    expect(invalidateCacheMock).toHaveBeenCalledWith(10)
  })

  it('渲染不出来的正文返回错误消息, 不写库、不记日志', async () => {
    renderMock.mockResolvedValue(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    await expect(
      updateComment({ commentId: 1, content: 'deep', isSpoiler: false }, 99)
    ).resolves.toBe('评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交')

    expect(transactionMock).not.toHaveBeenCalled()
    expect(invalidateCacheMock).not.toHaveBeenCalled()
  })
})
