import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  resourceFindUniqueMock,
  transactionMock,
  transactionQueryRawMock,
  transactionLinkFindManyMock,
  transactionUserUpdateMock,
  transactionResourceDeleteMock,
  cleanupResourceCommentDerivativesMock,
  enqueueResourceLinkDeletionsMock,
  recalcPatchTypeMock,
  deletePendingModerationTasksMock,
  deleteOrphanReportsMock,
  enqueueSearchOutboxMock,
  queueSearchSyncMock,
  invalidatePatchResourceDetailCacheMock,
  invalidateResourceListCacheMock,
  invalidatePatchContentCacheMock,
  invalidateUserSessionMock,
  invalidateUserPendingResourceCacheMock,
  kickS3DeletionDrainMock
} = vi.hoisted(() => ({
  resourceFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  transactionQueryRawMock: vi.fn(),
  transactionLinkFindManyMock: vi.fn(),
  transactionUserUpdateMock: vi.fn(),
  transactionResourceDeleteMock: vi.fn(),
  cleanupResourceCommentDerivativesMock: vi.fn(),
  enqueueResourceLinkDeletionsMock: vi.fn(),
  recalcPatchTypeMock: vi.fn(),
  deletePendingModerationTasksMock: vi.fn(),
  deleteOrphanReportsMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  invalidatePatchResourceDetailCacheMock: vi.fn(),
  invalidateResourceListCacheMock: vi.fn(),
  invalidatePatchContentCacheMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  invalidateUserPendingResourceCacheMock: vi.fn(),
  kickS3DeletionDrainMock: vi.fn()
}))

const transactionClient = {
  user: { update: transactionUserUpdateMock },
  patch_resource: { delete: transactionResourceDeleteMock },
  patch_resource_link: { findMany: transactionLinkFindManyMock },
  $queryRaw: transactionQueryRawMock
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_resource: { findUnique: resourceFindUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  cleanupResourceCommentDerivatives: cleanupResourceCommentDerivativesMock,
  enqueueResourceLinkDeletions: enqueueResourceLinkDeletionsMock,
  recalcPatchType: recalcPatchTypeMock
}))

vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: invalidatePatchResourceDetailCacheMock
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: invalidateResourceListCacheMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidatePatchContentCacheMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: invalidateUserPendingResourceCacheMock
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: deletePendingModerationTasksMock
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: vi.fn()
}))

vi.mock('~/server/report/pending', () => ({
  deleteOrphanReports: deleteOrphanReportsMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock,
  queueSearchSync: queueSearchSyncMock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: kickS3DeletionDrainMock
}))

import { deleteResource } from '~/app/api/patch/resource/delete'

// 事务外预取的快照: 守卫初检用它, 复检场景中恒为公开态
const buildSnapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  status: 0,
  section: 'galgame',
  user_id: 7,
  patch_id: 10,
  ...overrides
})

// 扣分先于行锁 (锁序 user → patch_resource 承重不可调序), 守卫拒绝必须以
// throw 传播出事务回调, 否则先行的扣分会随 return 一并提交
let transactionCommitted: boolean | null = null

const expectRollbackNoSideEffects = () => {
  expect(transactionCommitted).toBe(false)
  expect(transactionResourceDeleteMock).not.toHaveBeenCalled()
  expect(cleanupResourceCommentDerivativesMock).not.toHaveBeenCalled()
  expect(enqueueResourceLinkDeletionsMock).not.toHaveBeenCalled()
  expect(recalcPatchTypeMock).not.toHaveBeenCalled()
  expect(deletePendingModerationTasksMock).not.toHaveBeenCalled()
  expect(enqueueSearchOutboxMock).not.toHaveBeenCalled()
  expect(queueSearchSyncMock).not.toHaveBeenCalled()
  expect(invalidatePatchContentCacheMock).not.toHaveBeenCalled()
  expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
  expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  expect(invalidateUserPendingResourceCacheMock).not.toHaveBeenCalled()
  expect(kickS3DeletionDrainMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  transactionCommitted = null
  transactionLinkFindManyMock.mockResolvedValue([])
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  recalcPatchTypeMock.mockResolvedValue('patch-10')
  transactionUserUpdateMock.mockResolvedValue({})
  transactionMock.mockImplementation(
    async (callback: (client: typeof transactionClient) => unknown) => {
      transactionCommitted = false
      const result = await callback(transactionClient)
      transactionCommitted = true
      return result
    }
  )
})

// 事务外守卫读的是快照, 与行锁之间隔着扣分写入与等锁的窗口; 行锁的阻塞恰恰
// 保证本事务在并发提交之后才继续, 不复检即物理删除管理员刚隐藏或已送审的行
describe('删除资源在行锁下复检守卫', () => {
  it('快照公开但锁下已被隐藏, 拒绝删除并回滚扣分', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([{ id: 1, status: 1 }])

    const result = await deleteResource({ resourceId: 1 }, 7, 2)

    expect(result).toBe('未找到对应的资源')
    // 扣分确实发生在回调内, 守卫必须靠 throw 让它随回滚消失
    expect(transactionUserUpdateMock).toHaveBeenCalledTimes(1)
    expectRollbackNoSideEffects()
  })

  // 前台端点不管理隐藏资源 (与预检语义一致), 复检对管理员同样生效
  it('隐藏复检对管理员同样生效', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([{ id: 1, status: 1 }])

    const result = await deleteResource({ resourceId: 1 }, 9, 3)

    expect(result).toBe('未找到对应的资源')
    expectRollbackNoSideEffects()
  })

  it('快照公开但锁下已转待审核, 非特权作者被拒', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([{ id: 1, status: 3 }])

    const result = await deleteResource({ resourceId: 1 }, 7, 2)

    expect(result).toBe('该资源正在审核中, 暂时无法删除')
    expect(transactionUserUpdateMock).toHaveBeenCalledTimes(1)
    expectRollbackNoSideEffects()
  })

  it('锁下待审核不拦管理员, 保持事务外守卫语义', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot({ status: 3 }))
    transactionQueryRawMock.mockResolvedValue([{ id: 1, status: 3 }])
    // delete 返回值 = 删除瞬间快照, 提交后的缓存分派读它
    transactionResourceDeleteMock.mockResolvedValue({
      id: 1,
      status: 3,
      section: 'galgame',
      user_id: 7,
      patch_id: 10
    })

    const result = await deleteResource({ resourceId: 1 }, 9, 3)

    expect(typeof result).not.toBe('string')
    expect(transactionCommitted).toBe(true)
    expect(transactionResourceDeleteMock).toHaveBeenCalledTimes(1)
  })
})
