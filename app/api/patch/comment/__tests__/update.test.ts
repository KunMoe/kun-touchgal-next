import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findCommentMock,
  transactionMock,
  updateCommentMock,
  renderMock,
  planTextModerationMock,
  enqueueTextModerationMock,
  hasPendingModerationMock,
  invalidateCommentCacheMock,
  invalidateContentCacheMock
} = vi.hoisted(() => ({
  findCommentMock: vi.fn(),
  transactionMock: vi.fn(),
  updateCommentMock: vi.fn(),
  renderMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  enqueueTextModerationMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  invalidateCommentCacheMock: vi.fn(),
  invalidateContentCacheMock: vi.fn()
}))

const transactionClient = { patch_comment: { update: updateCommentMock } }

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findUnique: findCommentMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: renderMock
}))

vi.mock('~/server/moderation/submit', () => ({
  enqueueTextModeration: enqueueTextModerationMock,
  hasPendingModeration: hasPendingModerationMock,
  planTextModeration: planTextModerationMock
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: invalidateCommentCacheMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCacheByPatchId: invalidateContentCacheMock
}))

import { commentSubject } from '~/server/moderation/subject'
import { updateComment } from '~/app/api/patch/comment/update'

const stored = {
  id: 5,
  patch_id: 10,
  user_id: 7,
  content: 'before',
  status: 0
}
const input = { commentId: 5, content: 'after', isSpoiler: false }
const SKIP = { queue: false, intercept: false, dryRun: false }
const INTERCEPT = { queue: true, intercept: true, dryRun: false }

beforeEach(() => {
  vi.resetAllMocks()
  findCommentMock.mockResolvedValue(stored)
  hasPendingModerationMock.mockResolvedValue(false)
  renderMock.mockResolvedValue({ html: '<p>after</p>', version: 1 })
  planTextModerationMock.mockResolvedValue(SKIP)
  invalidateContentCacheMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => unknown) =>
      callback(transactionClient)
  )
})

describe('updateComment 送审', () => {
  // 先发正常内容再改成违规即可绕过审核, 所以编辑必须把新旧正文都交给预筛
  it('把编辑前的正文作为 previous 交给预筛, 由预筛判定是否重审', async () => {
    await updateComment(input, 7, 1)

    expect(planTextModerationMock).toHaveBeenCalledWith(
      commentSubject('after'),
      { userRole: 1, previous: commentSubject('before') }
    )
  })

  it('预筛放行时不改状态、不建任务', async () => {
    await updateComment(input, 7, 1)

    expect(updateCommentMock.mock.calls[0][0].data.status).toBeUndefined()
    expect(enqueueTextModerationMock).not.toHaveBeenCalled()
    expect(invalidateContentCacheMock).not.toHaveBeenCalled()
  })

  it('预筛拦截时评论转待审核, 并在同一事务内按评论作者建任务', async () => {
    planTextModerationMock.mockResolvedValue(INTERCEPT)

    // 管理员 (uid 9) 代改他人评论: 任务仍归评论作者
    await updateComment(input, 9, 3)

    expect(updateCommentMock.mock.calls[0][0].data.status).toBe(1)
    expect(enqueueTextModerationMock).toHaveBeenCalledWith(
      transactionClient,
      INTERCEPT,
      { contentId: 5, userId: 7 }
    )
    expect(invalidateContentCacheMock).toHaveBeenCalledWith(10)
  })

  it('灰度任务只排队, 不改评论状态', async () => {
    const dryRun = { queue: true, intercept: false, dryRun: true }
    planTextModerationMock.mockResolvedValue(dryRun)

    await updateComment(input, 7, 1)

    expect(updateCommentMock.mock.calls[0][0].data.status).toBeUndefined()
    expect(enqueueTextModerationMock).toHaveBeenCalledWith(
      transactionClient,
      dryRun,
      { contentId: 5, userId: 7 }
    )
  })

  it('渲染不出来的正文返回错误消息, 不进入预筛、不写库', async () => {
    renderMock.mockResolvedValue(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    expect(await updateComment(input, 7, 1)).toBe(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
    expect(renderMock).toHaveBeenCalledWith('comment', 'after')
    expect(planTextModerationMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
    expect(invalidateCommentCacheMock).not.toHaveBeenCalled()
  })

  it('正文与派生 HTML、版本一起落库', async () => {
    const result = await updateComment(input, 7, 1)

    expect(updateCommentMock.mock.calls[0][0].data).toMatchObject({
      content: 'after',
      content_html: '<p>after</p>',
      content_html_version: 1
    })
    expect(result).toEqual({
      contentHtml: '<p>after</p>',
      contentPreview: 'after'
    })
  })

  it('审核中的评论禁止作者再次修改, 不进入预筛', async () => {
    hasPendingModerationMock.mockResolvedValue(true)

    expect(await updateComment(input, 7, 1)).toBe(
      '您发布的评论正在审核中, 暂时无法修改'
    )
    expect(planTextModerationMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })
})
