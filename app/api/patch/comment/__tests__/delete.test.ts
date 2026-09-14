import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUniqueMock,
  transactionMock,
  queryRawMock,
  deleteMock,
  cleanupNotificationsMock,
  deletePendingModerationTasksMock,
  deletePendingAppealsMock,
  deleteOrphanReportsMock,
  invalidateCommentCacheMock,
  invalidateContentMock
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  queryRawMock: vi.fn(),
  deleteMock: vi.fn(),
  cleanupNotificationsMock: vi.fn(),
  deletePendingModerationTasksMock: vi.fn(),
  deletePendingAppealsMock: vi.fn(),
  deleteOrphanReportsMock: vi.fn(),
  invalidateCommentCacheMock: vi.fn(async () => undefined),
  invalidateContentMock: vi.fn(async () => undefined)
}))

const transactionClient = {
  $queryRaw: queryRawMock,
  patch_comment: { delete: deleteMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findUnique: findUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/comment/notifications', () => ({
  cleanupCommentNotifications: cleanupNotificationsMock
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: deletePendingModerationTasksMock
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: deletePendingAppealsMock
}))

vi.mock('~/server/report/pending', () => ({
  deleteOrphanReports: deleteOrphanReportsMock
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: invalidateCommentCacheMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock
}))

import { deleteComment } from '~/app/api/patch/comment/delete'

const baseComment = {
  id: 11,
  user_id: 7,
  resource_id: null,
  patch_id: 10,
  status: 0,
  patch: { unique_id: 'patch-10' }
}

beforeEach(() => {
  vi.clearAllMocks()
  queryRawMock.mockResolvedValue([{ id: 11 }])
  deleteMock.mockResolvedValue({})
  cleanupNotificationsMock.mockResolvedValue(undefined)
  deleteOrphanReportsMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('deleteComment 通知清理', () => {
  it('整棵子树的通知在行删除前一次清理', async () => {
    findUniqueMock.mockResolvedValue(baseComment)
    queryRawMock.mockResolvedValue([{ id: 11 }, { id: 12 }])

    const result = await deleteComment({ commentId: 11 }, 7, 1)

    expect(result).toEqual({})
    expect(cleanupNotificationsMock).toHaveBeenCalledTimes(1)
    expect(cleanupNotificationsMock).toHaveBeenCalledWith(
      transactionClient,
      [11, 12]
    )
    // 行删除后深链无从重建, 清理必须在 delete 之前
    expect(cleanupNotificationsMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMock.mock.invocationCallOrder[0]
    )
  })

  it('无回复的顶层评论同样清理 (点赞/提及通知挂在根评论上)', async () => {
    findUniqueMock.mockResolvedValue(baseComment)

    await deleteComment({ commentId: 11 }, 7, 1)

    expect(cleanupNotificationsMock).toHaveBeenCalledWith(
      transactionClient,
      [11]
    )
  })
})

describe('deleteComment 级联删除', () => {
  it('只对根执行一次 delete, 子树 id 一次收集后复用', async () => {
    findUniqueMock.mockResolvedValue(baseComment)
    queryRawMock.mockResolvedValue([{ id: 11 }, { id: 12 }, { id: 13 }])

    await deleteComment({ commentId: 11 }, 7, 1)

    expect(queryRawMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 11 } })
    expect(deletePendingModerationTasksMock).toHaveBeenCalledWith(
      'comment',
      [11, 12, 13],
      transactionClient
    )
    expect(deletePendingAppealsMock).toHaveBeenCalledWith(
      'comment',
      [11, 12, 13],
      transactionClient
    )
  })
})

describe('deleteComment 举报清理', () => {
  it('删除后按 NULL 目标清理级联置空的孤儿举报', async () => {
    findUniqueMock.mockResolvedValue(baseComment)

    await deleteComment({ commentId: 11 }, 7, 1)

    expect(deleteOrphanReportsMock).toHaveBeenCalledWith(
      'comment',
      transactionClient
    )
    expect(deleteMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteOrphanReportsMock.mock.invocationCallOrder[0]
    )
  })
})
