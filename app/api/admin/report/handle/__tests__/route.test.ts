import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParsePostBodyMock,
  verifyHeaderCookieMock,
  findReportMock,
  transactionMock,
  findRelatedReportsMock,
  deleteReportsMock,
  planCommentRemovalMock,
  executeCommentRemovalMock,
  planRatingRemovalMock,
  executeRatingRemovalMock,
  updateReportsMock,
  closeRelatedReportsMock,
  createMessagesMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  kunParsePostBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findReportMock: vi.fn(),
  transactionMock: vi.fn(),
  findRelatedReportsMock: vi.fn(),
  deleteReportsMock: vi.fn(),
  planCommentRemovalMock: vi.fn(),
  executeCommentRemovalMock: vi.fn(),
  planRatingRemovalMock: vi.fn(),
  executeRatingRemovalMock: vi.fn(),
  updateReportsMock: vi.fn(),
  closeRelatedReportsMock: vi.fn(),
  createMessagesMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const events: string[] = []
const transactionClient = {
  patch_report: {
    findMany: findRelatedReportsMock,
    updateMany: updateReportsMock,
    updateManyAndReturn: closeRelatedReportsMock,
    deleteMany: deleteReportsMock
  },
  user_message: { createMany: createMessagesMock }
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

// 删除的锁、清理顺序、统计重算与缓存失效由命令自己的测试覆盖; 这里只看入口怎么用它
vi.mock('~/server/content/comment/remove', () => ({
  planCommentRemoval: planCommentRemovalMock,
  executeCommentRemoval: executeCommentRemovalMock
}))

vi.mock('~/server/content/rating/remove', () => ({
  planRatingRemoval: planRatingRemovalMock,
  executeRatingRemoval: executeRatingRemovalMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

import { POST } from '~/app/api/admin/report/handle/route'

const request = new Request('http://localhost/api/admin/report/handle', {
  method: 'POST'
}) as unknown as Parameters<typeof POST>[0]

const ratingReport = {
  id: 1,
  status: 0,
  target_type: 'rating',
  reason: 'spam',
  sender_id: 7,
  comment_id: null,
  rating_id: 5
}
const commentReport = {
  ...ratingReport,
  target_type: 'comment',
  comment_id: 5,
  rating_id: null
}

const handledData = expect.objectContaining({ status: 2, handler_id: 99 })
const txContext = expect.objectContaining({ tx: transactionClient })

// 断言一组 mock 的首次 (或指定次) 调用按给定先后发生
const expectInOrder = (calls: number[]) =>
  expect(calls).toEqual([...calls].sort((a, b) => a - b))

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  kunParsePostBodyMock.mockResolvedValue({
    reportId: 1,
    action: 'delete',
    content: ''
  })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99, role: 4 })
  findReportMock.mockResolvedValue(ratingReport)
  // 本条举报在认领时已转为已处理, 「同目标的其余未处理举报」里不含它
  findRelatedReportsMock.mockResolvedValue([])
  updateReportsMock.mockResolvedValue({ count: 1 })
  // 其余举报的结案缺省全部命中: 原样返回被结案的行
  closeRelatedReportsMock.mockImplementation(
    async () => findRelatedReportsMock.mock.results.at(-1)?.value
  )
  deleteReportsMock.mockResolvedValue({ count: 0 })
  createMessagesMock.mockResolvedValue({ count: 1 })
  planCommentRemovalMock.mockResolvedValue({
    roots: [{ id: 5 }],
    skipped: [],
    subtree: [{ id: 5 }, { id: 6 }, { id: 7 }]
  })
  executeCommentRemovalMock.mockResolvedValue({ deletedIds: [5, 6, 7] })
  planRatingRemovalMock.mockResolvedValue({
    rows: [{ id: 5, user_id: 8, patch_id: 10, status: 0 }],
    skipped: []
  })
  executeRatingRemovalMock.mockResolvedValue({ deletedIds: [5] })
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
})

describe('POST /api/admin/report/handle 删除评价', () => {
  // 锁序「内容行 → 举报行」: 删除内容会把举报的目标 id 级联置空, 先碰举报行
  // 再等内容行会与它反序
  it('locks the rating, claims the report, deletes, then cleans orphaned reports', async () => {
    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    // 后台处理举报不设守卫
    expect(planRatingRemovalMock).toHaveBeenCalledWith(txContext, [5])
    expect(updateReportsMock.mock.calls[0][0]).toEqual({
      where: { id: 1, status: 0 },
      data: handledData
    })
    // 孤儿举报由本入口在结案之后清, 不让删除命令内联清理
    expect(executeRatingRemovalMock).toHaveBeenCalledWith(
      txContext,
      await planRatingRemovalMock.mock.results[0].value,
      { orphanReports: 'caller' }
    )
    // 收集窗口内新提交的举报被级联置空: 待已收集的举报转为历史后, 按 NULL 目标
    // 兜底清理 (先兜底会误删仍处 pending 的已收集举报)
    expect(deleteReportsMock).toHaveBeenCalledWith({
      where: { target_type: 'rating', status: 0, rating_id: null }
    })
    expectInOrder([
      planRatingRemovalMock.mock.invocationCallOrder[0],
      updateReportsMock.mock.invocationCallOrder[0],
      findRelatedReportsMock.mock.invocationCallOrder[0],
      executeRatingRemovalMock.mock.invocationCallOrder[0],
      deleteReportsMock.mock.invocationCallOrder[0],
      createMessagesMock.mock.invocationCallOrder[0]
    ])
    expect(planCommentRemovalMock).not.toHaveBeenCalled()
    // 举报人未读缓存须在提交后失效 (L-01): 事务内失效会被并发读回填旧值
    expect(events).toEqual([
      'transaction-start',
      'transaction-commit',
      'invalidate-unread:7'
    ])
  })

  // 两个管理员同时处理同一条举报: 后到的一方认领落空, 整个事务回滚
  it('rejects a report that was handled between the read and the claim', async () => {
    updateReportsMock.mockResolvedValue({ count: 0 })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('该举报已被处理')
    expect(events).toEqual(['transaction-start'])
    expect(executeRatingRemovalMock).not.toHaveBeenCalled()
    expect(createMessagesMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('closes the other pending reports on the same rating without overwriting handled ones', async () => {
    findRelatedReportsMock.mockResolvedValue([
      { id: 2, sender_id: 8, reason: 'abuse' }
    ])

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    expect(findRelatedReportsMock).toHaveBeenCalledWith({
      where: { status: 0, target_type: 'rating', rating_id: 5 },
      select: { id: true, sender_id: true, reason: true }
    })
    expect(closeRelatedReportsMock).toHaveBeenCalledWith({
      where: { id: { in: [2] }, status: 0 },
      data: handledData,
      select: { sender_id: true, reason: true }
    })
    // 其余举报结案之后才清孤儿
    expectInOrder([
      executeRatingRemovalMock.mock.invocationCallOrder[0],
      closeRelatedReportsMock.mock.invocationCallOrder[0],
      deleteReportsMock.mock.invocationCallOrder[0]
    ])
    expect(invalidateUnreadMock.mock.calls.map((call) => call[0])).toEqual([
      7, 8
    ])
  })
})

describe('POST /api/admin/report/handle 删除评论', () => {
  beforeEach(() => {
    findReportMock.mockResolvedValue(commentReport)
  })

  it('handles pending reports across the reply subtree when deleting a comment', async () => {
    findRelatedReportsMock.mockResolvedValue([
      { id: 2, sender_id: 8, reason: 'reply spam' }
    ])

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    // 先锁评论行并收集整棵回复子树
    expect(planCommentRemovalMock).toHaveBeenCalledWith(txContext, [5])
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
    expect(executeCommentRemovalMock).toHaveBeenCalledWith(
      txContext,
      await planCommentRemovalMock.mock.results[0].value,
      { orphanReports: 'caller' }
    )
    // 其余举报带着 status 条件结案, 不覆盖别人已写下的结案记录
    expect(closeRelatedReportsMock).toHaveBeenCalledWith({
      where: { id: { in: [2] }, status: 0 },
      data: handledData,
      select: { sender_id: true, reason: true }
    })
    expect(deleteReportsMock).toHaveBeenCalledWith({
      where: { target_type: 'comment', status: 0, comment_id: null }
    })
    // 举报的收集必须发生在删除之前: 删除触发 ON DELETE SET NULL, 之后按
    // comment_id 收集会漏掉一切
    expectInOrder([
      planCommentRemovalMock.mock.invocationCallOrder[0],
      updateReportsMock.mock.invocationCallOrder[0],
      findRelatedReportsMock.mock.invocationCallOrder[0],
      executeCommentRemovalMock.mock.invocationCallOrder[0],
      closeRelatedReportsMock.mock.invocationCallOrder[0],
      deleteReportsMock.mock.invocationCallOrder[0]
    ])
    // 被处理的举报人各收一条通知: 本条举报的 7 与子树举报的 8
    const messageRows = createMessagesMock.mock.calls[0][0].data
    expect(
      messageRows.map((row: { recipient_id: number }) => row.recipient_id)
    ).toEqual([7, 8])
    expect(messageRows[1].content).toContain('举报原因：reply spam')
    expect(invalidateUnreadMock.mock.calls.map((call) => call[0])).toEqual([
      7, 8
    ])
    expect(planRatingRemovalMock).not.toHaveBeenCalled()
  })

  // A 处理根评论的举报并删除, 同时 B 处理了回复上的举报 (比如驳回)。A 收集时那条举报
  // 还未处理, 结案时已被 B 抢先: A 不能再给它的举报人发「您的举报已处理」
  it('does not notify the reporter of a related report someone else closed in between', async () => {
    findRelatedReportsMock.mockResolvedValue([
      { id: 2, sender_id: 8, reason: 'reply spam' },
      { id: 3, sender_id: 9, reason: 'also spam' }
    ])
    // 只有 3 在结案时仍未处理
    closeRelatedReportsMock.mockResolvedValue([
      { sender_id: 9, reason: 'also spam' }
    ])

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    const messageRows = createMessagesMock.mock.calls[0][0].data
    expect(
      messageRows.map((row: { recipient_id: number }) => row.recipient_id)
    ).toEqual([7, 9])
    expect(invalidateUnreadMock.mock.calls.map((call) => call[0])).toEqual([
      7, 9
    ])
  })

  it('does not lock or collect a comment subtree when rejecting a comment report', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      reportId: 1,
      action: 'reject',
      content: ''
    })

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    // 驳回不删除评论, 子树举报的目标仍然存在, 只处理同目标的举报
    expect(planCommentRemovalMock).not.toHaveBeenCalled()
    expect(executeCommentRemovalMock).not.toHaveBeenCalled()
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

describe('POST /api/admin/report/handle 事务外预检', () => {
  it('skips notifications and unread invalidation when the report is already handled', async () => {
    findReportMock.mockResolvedValue({ ...ratingReport, status: 2 })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('该举报已被处理')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  // 目标内容已被别处删除 (举报的目标 id 被级联置空): 只结案这一条, 不再删除
  it('only closes the report when its target is already gone', async () => {
    findReportMock.mockResolvedValue({ ...ratingReport, rating_id: null })

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    expect(planRatingRemovalMock).not.toHaveBeenCalled()
    expect(findRelatedReportsMock).not.toHaveBeenCalled()
    expect(deleteReportsMock).not.toHaveBeenCalled()
    expect(updateReportsMock).toHaveBeenCalledTimes(1)
    expect(closeRelatedReportsMock).not.toHaveBeenCalled()
  })
})
