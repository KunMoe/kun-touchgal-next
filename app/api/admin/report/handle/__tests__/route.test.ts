import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParsePostBodyMock,
  verifyHeaderCookieMock,
  findReportMock,
  transactionMock,
  findRelatedReportsMock,
  deleteReportsMock,
  deleteRatingMock,
  planCommentRemovalMock,
  executeCommentRemovalMock,
  queryRawMock,
  updateReportsMock,
  createMessagesMock,
  recomputeOneMock,
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
  planCommentRemovalMock: vi.fn(),
  executeCommentRemovalMock: vi.fn(),
  queryRawMock: vi.fn(),
  updateReportsMock: vi.fn(),
  createMessagesMock: vi.fn(),
  recomputeOneMock: vi.fn(),
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

// 评论删除的锁、清理顺序与缓存失效由命令自己的测试覆盖; 这里只看入口怎么用它
vi.mock('~/server/content/comment/remove', () => ({
  planCommentRemoval: planCommentRemovalMock,
  executeCommentRemoval: executeCommentRemovalMock
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
    sender_id: 7,
    comment_id: null,
    rating_id: 5,
    patch_id: 10
  })
  // 本条举报在认领时已转为已处理, 「同目标的其余未处理举报」里不含它
  findRelatedReportsMock.mockResolvedValue([])
  deleteRatingMock.mockResolvedValue({ count: 1 })
  queryRawMock.mockResolvedValue([{ id: 5 }])
  planCommentRemovalMock.mockResolvedValue({
    roots: [{ id: 5 }],
    skipped: [],
    subtree: [{ id: 5 }, { id: 6 }, { id: 7 }]
  })
  executeCommentRemovalMock.mockResolvedValue({ deletedIds: [5, 6, 7] })
  updateReportsMock.mockResolvedValue({ count: 1 })
  deleteReportsMock.mockResolvedValue({ count: 0 })
  createMessagesMock.mockResolvedValue({ count: 1 })
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

// 评分删除路径上 recompute 被夹具挂起以观察事务边界; 不关心边界的用例直接放行
const runToCompletion = async () => {
  const pending = POST(request)
  await recomputeStarted
  finishRecompute()
  return pending
}

const commentReport = {
  id: 1,
  status: 0,
  target_type: 'comment',
  reason: 'spam',
  sender_id: 7,
  comment_id: 5,
  rating_id: null,
  patch_id: 10
}

const handledData = expect.objectContaining({ status: 2, handler_id: 99 })

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

  // 锁序「内容行 → 举报行」: 删除内容会把举报的目标 id 级联置空, 先碰举报行
  // 再等内容行会与它反序
  it('locks the rating row, then claims the report, then deletes', async () => {
    const response = await runToCompletion()

    await expect(response.json()).resolves.toEqual({})
    expect(queryRawMock).toHaveBeenCalledTimes(1)
    expect(updateReportsMock.mock.calls[0][0]).toEqual({
      where: { id: 1, status: 0 },
      data: handledData
    })
    const claimed = updateReportsMock.mock.invocationCallOrder[0]
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(claimed)
    expect(claimed).toBeLessThan(deleteRatingMock.mock.invocationCallOrder[0])
  })

  // 两个管理员同时处理同一条举报: 后到的一方认领落空, 整个事务回滚
  it('rejects a report that was handled between the read and the claim', async () => {
    updateReportsMock.mockResolvedValue({ count: 0 })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('该举报已被处理')
    expect(events).toEqual(['transaction-start'])
    expect(deleteRatingMock).not.toHaveBeenCalled()
    expect(createMessagesMock).not.toHaveBeenCalled()
    expect(recomputeOneMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
    expect(invalidateContentCacheMock).not.toHaveBeenCalled()
  })

  it('handles pending reports across the reply subtree when deleting a comment', async () => {
    findReportMock.mockResolvedValue(commentReport)
    findRelatedReportsMock.mockResolvedValue([
      { id: 2, sender_id: 8, reason: 'reply spam' }
    ])

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    // 后台处理举报不设守卫: 先锁评论行并收集整棵回复子树
    expect(planCommentRemovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ tx: transactionClient }),
      [5]
    )
    expect(updateReportsMock.mock.calls[0][0]).toEqual({
      where: { id: 1, status: 0 },
      data: handledData
    })
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
    // 孤儿举报由本入口在结案之后清, 不让删除命令内联清理
    expect(executeCommentRemovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ tx: transactionClient }),
      await planCommentRemovalMock.mock.results[0].value,
      { orphanReports: 'caller' }
    )
    // 其余举报带着 status 条件结案, 不覆盖别人已写下的结案记录
    expect(updateReportsMock.mock.calls[1][0]).toEqual({
      where: { id: { in: [2] }, status: 0 },
      data: handledData
    })
    expect(deleteReportsMock).toHaveBeenCalledWith({
      where: { target_type: 'comment', status: 0, comment_id: null }
    })
    // 顺序: 锁内容行 → 认领 → 收集其余举报 → 删除 → 其余举报结案 → 清孤儿
    const order = [
      planCommentRemovalMock.mock.invocationCallOrder[0],
      updateReportsMock.mock.invocationCallOrder[0],
      findRelatedReportsMock.mock.invocationCallOrder[0],
      executeCommentRemovalMock.mock.invocationCallOrder[0],
      updateReportsMock.mock.invocationCallOrder[1],
      deleteReportsMock.mock.invocationCallOrder[0]
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // 被处理的举报人各收一条通知: 本条举报的 7 与子树举报的 8
    const messageRows = createMessagesMock.mock.calls[0][0].data
    expect(
      messageRows.map((row: { recipient_id: number }) => row.recipient_id)
    ).toEqual([7, 8])
    expect(messageRows[1].content).toContain('举报原因：reply spam')
    expect(invalidateUnreadMock.mock.calls.map((call) => call[0])).toEqual([
      7, 8
    ])
    expect(recomputeOneMock).not.toHaveBeenCalled()
  })

  it('skips notifications and unread invalidation when the report is already handled', async () => {
    findReportMock.mockResolvedValue({
      id: 1,
      status: 2,
      target_type: 'rating',
      reason: 'spam',
      sender_id: 7,
      comment_id: null,
      rating_id: 5,
      patch_id: 10
    })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('该举报已被处理')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('does not lock or collect a comment subtree when rejecting a comment report', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      reportId: 1,
      action: 'reject',
      content: ''
    })
    findReportMock.mockResolvedValue(commentReport)

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    // 驳回不删除评论, 子树举报的目标仍然存在, 只处理同目标的举报
    expect(planCommentRemovalMock).not.toHaveBeenCalled()
    expect(executeCommentRemovalMock).not.toHaveBeenCalled()
    expect(queryRawMock).not.toHaveBeenCalled()
    // 未删除内容 → 不产生孤儿, 不做兜底清理
    expect(deleteReportsMock).not.toHaveBeenCalled()
    expect(updateReportsMock.mock.calls[0][0]).toEqual({
      where: { id: 1, status: 0 },
      data: expect.objectContaining({ status: 3, handler_reply: '已驳回' })
    })
    expect(findRelatedReportsMock).toHaveBeenCalledWith({
      where: { status: 0, target_type: 'comment', comment_id: 5 },
      select: { id: true, sender_id: true, reason: true }
    })
    expect(createMessagesMock.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        recipient_id: 7,
        content: '您的举报已驳回\n\n举报原因：spam\n驳回回复：已驳回'
      })
    ])
  })
})
