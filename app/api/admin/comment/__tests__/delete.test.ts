import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findCommentsMock,
  findAdminMock,
  transactionMock,
  queryRawMock,
  deleteManyMock,
  createLogMock,
  cleanupNotificationsMock,
  deletePendingModerationTasksMock,
  deletePendingAppealsMock,
  deleteOrphanReportsMock,
  invalidateCommentCacheMock,
  invalidateContentMock
} = vi.hoisted(() => ({
  findCommentsMock: vi.fn(),
  findAdminMock: vi.fn(),
  transactionMock: vi.fn(),
  queryRawMock: vi.fn(),
  deleteManyMock: vi.fn(),
  createLogMock: vi.fn(),
  cleanupNotificationsMock: vi.fn(),
  deletePendingModerationTasksMock: vi.fn(),
  deletePendingAppealsMock: vi.fn(),
  deleteOrphanReportsMock: vi.fn(),
  invalidateCommentCacheMock: vi.fn(async () => undefined),
  invalidateContentMock: vi.fn(async () => undefined)
}))

const transactionClient = {
  $queryRaw: queryRawMock,
  patch_comment: { deleteMany: deleteManyMock },
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findMany: findCommentsMock },
    user: { findUnique: findAdminMock },
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
  invalidatePatchContentCacheByPatchId: invalidateContentMock
}))

import { deleteComment } from '~/app/api/admin/comment/delete'

const makeComment = (id: number, patchId: number) => ({
  id,
  user_id: 7,
  patch_id: patchId,
  parent_id: null,
  content: '评论正文'
})

beforeEach(() => {
  vi.clearAllMocks()
  findCommentsMock.mockResolvedValue([makeComment(11, 10)])
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  queryRawMock.mockResolvedValue([{ id: 11 }, { id: 12 }])
  deleteManyMock.mockResolvedValue({ count: 1 })
  createLogMock.mockResolvedValue({})
  cleanupNotificationsMock.mockResolvedValue(undefined)
  deleteOrphanReportsMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('adminDeleteComment 通知清理', () => {
  it('按完整子树 id 在行删除前清理通知', async () => {
    const result = await deleteComment({ commentIds: [11] }, 99)

    expect(result).toEqual({ deletedIds: [11, 12] })
    expect(cleanupNotificationsMock).toHaveBeenCalledTimes(1)
    expect(cleanupNotificationsMock).toHaveBeenCalledWith(
      transactionClient,
      [11, 12]
    )
    // 行删除后深链无从重建, 清理必须在 deleteMany 之前
    expect(cleanupNotificationsMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteManyMock.mock.invocationCallOrder[0]
    )
  })

  it('跨补丁批量删除: 一次清理覆盖全部子树 id', async () => {
    findCommentsMock.mockResolvedValue([
      makeComment(11, 10),
      makeComment(21, 20)
    ])
    queryRawMock.mockResolvedValue([{ id: 11 }, { id: 12 }, { id: 21 }])

    await deleteComment({ commentIds: [11, 21] }, 99)

    expect(cleanupNotificationsMock).toHaveBeenCalledTimes(1)
    expect(cleanupNotificationsMock).toHaveBeenCalledWith(
      transactionClient,
      [11, 12, 21]
    )
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: { in: [11, 21] } }
    })
  })
})
