import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParsePostBodyMock,
  verifyHeaderCookieMock,
  findReportMock,
  transactionMock,
  findRelatedReportsMock,
  deleteReportsMock,
  deleteRatingMock,
  deleteCommentMock,
  queryRawMock,
  updateReportsMock,
  createMessagesMock,
  recomputeOneMock,
  invalidateCommentCacheMock,
  invalidateContentCacheMock,
  deletePendingModerationTasksMock,
  deletePendingAppealsMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  kunParsePostBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findReportMock: vi.fn(),
  transactionMock: vi.fn(),
  findRelatedReportsMock: vi.fn(),
  deleteReportsMock: vi.fn(),
  deleteRatingMock: vi.fn(),
  deleteCommentMock: vi.fn(),
  queryRawMock: vi.fn(),
  updateReportsMock: vi.fn(),
  createMessagesMock: vi.fn(),
  recomputeOneMock: vi.fn(),
  invalidateCommentCacheMock: vi.fn(),
  invalidateContentCacheMock: vi.fn(),
  deletePendingModerationTasksMock: vi.fn(),
  deletePendingAppealsMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const events: string[] = []
let recomputeStarted: Promise<void>
let finishRecompute: () => void
const transactionClient = {
  patch_report: {
    findMany: findRelatedReportsMock,
    updateMany: updateReportsMock,
    deleteMany: deleteReportsMock
  },
  patch_rating: { deleteMany: deleteRatingMock },
  patch_comment: { deleteMany: deleteCommentMock },
  user_message: { createMany: createMessagesMock },
  $queryRaw: queryRawMock
}

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePostBody: kunParsePostBodyMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_report: { findUnique: findReportMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/rating/stat', () => ({
  recomputePatchRatingStat: recomputeOneMock
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: invalidateCommentCacheMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCacheByPatchId: invalidateContentCacheMock
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: deletePendingModerationTasksMock
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: deletePendingAppealsMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

import { POST } from '~/app/api/admin/report/handle/route'

const request = new Request('http://localhost/api/admin/report/handle', {
  method: 'POST'
}) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  const started = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  recomputeStarted = started.promise
  finishRecompute = () => {
    events.push('recompute')
    finished.resolve()
  }
  kunParsePostBodyMock.mockResolvedValue({
    reportId: 1,
    action: 'delete',
    content: ''
  })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99, role: 4 })
  findReportMock.mockResolvedValue({
    id: 1,
    status: 0,
    target_type: 'rating',
    reason: 'spam',
    comment_id: null,
    rating_id: 5,
    patch_id: 10
  })
  findRelatedReportsMock.mockResolvedValue([
    { id: 1, sender_id: 7, reason: 'spam' }
  ])
  deleteRatingMock.mockResolvedValue({ count: 1 })
  deleteCommentMock.mockResolvedValue({ count: 1 })
  queryRawMock.mockResolvedValue([])
  updateReportsMock.mockResolvedValue({ count: 1 })
  deleteReportsMock.mockResolvedValue({ count: 0 })
  createMessagesMock.mockResolvedValue({ count: 1 })
  invalidateCommentCacheMock.mockResolvedValue(undefined)
  invalidateContentCacheMock.mockResolvedValue(undefined)
  deletePendingModerationTasksMock.mockResolvedValue({ count: 0 })
  deletePendingAppealsMock.mockResolvedValue({ count: 0 })
  invalidateUnreadMock.mockImplementation(async (uid: number) => {
    events.push(`invalidate-unread:${uid}`)
  })
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      events.push('transaction-start')
      const result = await callback(transactionClient)
      events.push('transaction-commit')
      return result
    }
  )
  recomputeOneMock.mockImplementation(() => {
    started.resolve()
    return finished.promise
  })
})

describe('POST /api/admin/report/handle', () => {
  it('deletes a reported rating and recomputes stats before commit', async () => {
    const pendingResponse = POST(request)
    await recomputeStarted
    await Promise.resolve()
    const eventsBeforeRecompute = [...events]
    finishRecompute()
    const response = await pendingResponse

    await expect(response.json()).resolves.toEqual({})
    expect(deleteRatingMock).toHaveBeenCalledWith({ where: { id: 5 } })
    expect(deletePendingModerationTasksMock).toHaveBeenCalledWith(
      'rating',
      [5],
      transactionClient
    )
    expect(deletePendingAppealsMock).toHaveBeenCalledWith(
      'rating',
      [5],
      transactionClient
    )
    expect(recomputeOneMock).toHaveBeenCalledWith(10, transactionClient)
    expect(deleteRatingMock.mock.invocationCallOrder[0]).toBeLessThan(
      recomputeOneMock.mock.invocationCallOrder[0]
    )
    // 收集窗口内新提交的举报被级联置空: 待 updateMany 将已收集举报转为
    // 历史后, 按 NULL 目标兜底清理 (先兜底会误删仍处 pending 的已收集举报)
    expect(deleteReportsMock).toHaveBeenCalledWith({
      where: { target_type: 'rating', status: 0, rating_id: null }
    })
    expect(updateReportsMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteReportsMock.mock.invocationCallOrder[0]
    )
    expect(eventsBeforeRecompute).toEqual(['transaction-start'])
    // 举报人未读缓存须在提交后失效 (L-01): 事务内失效会被并发读回填旧值
    expect(events).toEqual([
      'transaction-start',
      'recompute',
      'transaction-commit',
      'invalidate-unread:7'
    ])
  })

  it('handles pending reports across the reply subtree when deleting a comment', async () => {
    findReportMock.mockResolvedValue({
      id: 1,
      status: 0,
      target_type: 'comment',
      reason: 'spam',
      comment_id: 5,
      rating_id: null,
      patch_id: 10
    })
    queryRawMock.mockResolvedValue([{ id: 5 }, { id: 6 }, { id: 7 }])
    findRelatedReportsMock.mockResolvedValue([
      { id: 1, sender_id: 7, reason: 'spam' },
      { id: 2, sender_id: 8, reason: 'reply spam' }
    ])

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    // 删除 comment 会级联整棵回复子树, pending 举报须按子树全部 id 匹配,
    // 否则子树举报因 ON DELETE SET NULL 变成永远待处理的孤儿
    expect(findRelatedReportsMock).toHaveBeenCalledWith({
      where: {
        status: 0,
        target_type: 'comment',
        comment_id: { in: [5, 6, 7] }
      },
      select: { id: true, sender_id: true, reason: true }
    })
    expect(deleteCommentMock).toHaveBeenCalledWith({ where: { id: 5 } })
    // 子树收集与举报收集都必须发生在删除之前: 删除会级联子树并触发
    // ON DELETE SET NULL, 之后按 comment_id 收集会漏掉一切
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCommentMock.mock.invocationCallOrder[0]
    )
    expect(findRelatedReportsMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCommentMock.mock.invocationCallOrder[0]
    )
    expect(deletePendingModerationTasksMock).toHaveBeenCalledWith(
      'comment',
      [5, 6, 7],
      transactionClient
    )
    expect(deletePendingAppealsMock).toHaveBeenCalledWith(
      'comment',
      [5, 6, 7],
      transactionClient
    )
    expect(updateReportsMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1, 2] } } })
    )
    expect(deleteReportsMock).toHaveBeenCalledWith({
      where: { target_type: 'comment', status: 0, comment_id: null }
    })
    expect(updateReportsMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteReportsMock.mock.invocationCallOrder[0]
    )
    const messageRows = createMessagesMock.mock.calls[0][0].data
    expect(
      messageRows.map((row: { recipient_id: number }) => row.recipient_id)
    ).toEqual([7, 8])
    expect(invalidateUnreadMock.mock.calls.map((call) => call[0])).toEqual([
      7, 8
    ])
    expect(recomputeOneMock).not.toHaveBeenCalled()
    expect(invalidateCommentCacheMock).toHaveBeenCalledWith(10)
  })

  it('skips notifications and unread invalidation when the report is already handled', async () => {
    findReportMock.mockResolvedValue({
      id: 1,
      status: 2,
      target_type: 'rating',
      reason: 'spam',
      comment_id: null,
      rating_id: 5,
      patch_id: 10
    })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('该举报已被处理')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('does not notify or invalidate anyone when no pending report remains', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      reportId: 1,
      action: 'reject',
      content: ''
    })
    // 读取与事务之间被另一管理员抢先处理: 收集为空, 无收件人
    findRelatedReportsMock.mockResolvedValue([])

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    expect(createMessagesMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('does not collect a comment subtree when rejecting a comment report', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      reportId: 1,
      action: 'reject',
      content: ''
    })
    findReportMock.mockResolvedValue({
      id: 1,
      status: 0,
      target_type: 'comment',
      reason: 'spam',
      comment_id: 5,
      rating_id: null,
      patch_id: 10
    })

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    // 驳回不删除评论, 子树举报的目标仍然存在, 只处理同目标的举报
    expect(queryRawMock).not.toHaveBeenCalled()
    expect(deleteCommentMock).not.toHaveBeenCalled()
    // 未删除内容 → 不产生孤儿, 不做兜底清理
    expect(deleteReportsMock).not.toHaveBeenCalled()
    expect(findRelatedReportsMock).toHaveBeenCalledWith({
      where: { status: 0, target_type: 'comment', comment_id: 5 },
      select: { id: true, sender_id: true, reason: true }
    })
  })
})
