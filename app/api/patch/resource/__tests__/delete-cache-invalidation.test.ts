import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  userFindUniqueMock,
  resourceFindUniqueMock,
  transactionMock,
  transactionQueryRawMock,
  transactionLinkFindManyMock,
  transactionResourceFindUniqueMock,
  transactionResourceFindManyMock,
  transactionUserUpdateMock,
  transactionResourceDeleteMock,
  transactionResourceDeleteManyMock,
  transactionAdminLogCreateMock,
  cleanupResourceCommentDerivativesMock,
  enqueueResourceLinkDeletionsMock,
  recalcPatchTypeMock,
  sanitizeResourceLinksForAuditLogMock,
  deletePendingModerationTasksMock,
  deletePendingAppealsMock,
  deleteOrphanReportsMock,
  enqueueSearchOutboxMock,
  queueSearchSyncMock,
  kickSearchOutboxDrainMock,
  invalidatePatchResourceDetailCacheMock,
  invalidateResourceListCacheMock,
  invalidatePatchContentCacheMock,
  invalidateUserSessionMock,
  invalidateUserPendingResourceCacheMock,
  kickS3DeletionDrainMock
} = vi.hoisted(() => ({
  userFindUniqueMock: vi.fn(),
  resourceFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  transactionQueryRawMock: vi.fn(),
  transactionLinkFindManyMock: vi.fn(),
  transactionResourceFindUniqueMock: vi.fn(),
  transactionResourceFindManyMock: vi.fn(),
  transactionUserUpdateMock: vi.fn(),
  transactionResourceDeleteMock: vi.fn(),
  transactionResourceDeleteManyMock: vi.fn(),
  transactionAdminLogCreateMock: vi.fn(),
  cleanupResourceCommentDerivativesMock: vi.fn(),
  enqueueResourceLinkDeletionsMock: vi.fn(),
  recalcPatchTypeMock: vi.fn(),
  sanitizeResourceLinksForAuditLogMock: vi.fn(),
  deletePendingModerationTasksMock: vi.fn(),
  deletePendingAppealsMock: vi.fn(),
  deleteOrphanReportsMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  kickSearchOutboxDrainMock: vi.fn(),
  invalidatePatchResourceDetailCacheMock: vi.fn(),
  invalidateResourceListCacheMock: vi.fn(),
  invalidatePatchContentCacheMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  invalidateUserPendingResourceCacheMock: vi.fn(),
  kickS3DeletionDrainMock: vi.fn()
}))

const transactionClient = {
  user: { update: transactionUserUpdateMock },
  patch_resource: {
    delete: transactionResourceDeleteMock,
    deleteMany: transactionResourceDeleteManyMock,
    findUnique: transactionResourceFindUniqueMock,
    findMany: transactionResourceFindManyMock
  },
  patch_resource_link: { findMany: transactionLinkFindManyMock },
  admin_log: { create: transactionAdminLogCreateMock },
  $queryRaw: transactionQueryRawMock
}

vi.mock('~/prisma/index', () => ({
  isPrismaTransactionConflict: () => false,
  prisma: {
    user: { findUnique: userFindUniqueMock },
    patch_resource: { findUnique: resourceFindUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  cleanupResourceCommentDerivatives: cleanupResourceCommentDerivativesMock,
  enqueueResourceLinkDeletions: enqueueResourceLinkDeletionsMock,
  recalcPatchType: recalcPatchTypeMock,
  sanitizeResourceLinksForAuditLog: sanitizeResourceLinksForAuditLogMock
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
  deletePendingAppeals: deletePendingAppealsMock
}))

vi.mock('~/server/report/pending', () => ({
  deleteOrphanReports: deleteOrphanReportsMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock,
  enqueueSearchOutboxBatch: vi.fn(),
  queueSearchSync: queueSearchSyncMock,
  kickSearchOutboxDrain: kickSearchOutboxDrainMock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: kickS3DeletionDrainMock
}))

import { deleteResource } from '~/app/api/patch/resource/delete'
import { deleteResource as adminDeleteResource } from '~/app/api/admin/resource/delete'

// 事务外预取的快照, 权限判定与 S3 链接收集用它
const buildSnapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  status: 0,
  section: 'galgame',
  user_id: 7,
  patch_id: 10,
  links: [],
  patch: { name: 'Patch' },
  ...overrides
})

// 事务内 delete 的返回值, 即该行被删除瞬间的真实状态
const buildDeleted = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  status: 0,
  section: 'galgame',
  user_id: 7,
  patch_id: 10,
  ...overrides
})

beforeEach(() => {
  vi.resetAllMocks()
  userFindUniqueMock.mockResolvedValue({ id: 9, name: 'Admin' })
  // 事务内行锁命中 (status 供守卫复检) + 锁下重读: links 与 admin 审计快照的事实源
  transactionQueryRawMock.mockResolvedValue([{ id: 1, status: 0 }])
  transactionLinkFindManyMock.mockResolvedValue([])
  transactionResourceFindUniqueMock.mockImplementation(async () =>
    buildSnapshot()
  )
  // 管理端批量路径: 锁下 findMany 是删除瞬间状态的事实源
  transactionResourceFindManyMock.mockImplementation(async () => [
    buildSnapshot()
  ])
  cleanupResourceCommentDerivativesMock.mockResolvedValue(undefined)
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  recalcPatchTypeMock.mockResolvedValue('patch-10')
  sanitizeResourceLinksForAuditLogMock.mockReturnValue([])
  transactionMock.mockImplementation(
    async (callback: (client: typeof transactionClient) => unknown) =>
      callback(transactionClient)
  )
  transactionUserUpdateMock.mockResolvedValue({})
})

// 闸门读 delete 的返回值而非事务外快照: 两者之间存在并发 approve / 隐藏的窗口
describe('删除资源按删除瞬间状态分派缓存失效', () => {
  it('删除 section=galgame 的公开资源只失效详情缓存', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionResourceDeleteMock.mockResolvedValue(buildDeleted())

    await deleteResource({ resourceId: 1 }, 7, 2)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })

  it('删除 section=patch 的公开资源两个缓存都失效', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      buildSnapshot({ section: 'patch' })
    )
    transactionResourceDeleteMock.mockResolvedValue(
      buildDeleted({ section: 'patch' })
    )

    await deleteResource({ resourceId: 1 }, 7, 2)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateResourceListCacheMock).toHaveBeenCalledTimes(1)
  })

  // 快照 status=2, 并发 approve 提交后该行已是 0: 无守卫的 delete 删掉的是公开行
  it('快照为待审核但删除时已通过审核, 仍失效详情缓存', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot({ status: 2 }))
    transactionResourceDeleteMock.mockResolvedValue(buildDeleted({ status: 0 }))

    await deleteResource({ resourceId: 1 }, 7, 3)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserPendingResourceCacheMock).not.toHaveBeenCalled()
  })

  // 反向: 快照 status=0, 并发隐藏后该行已是 1 —— 前台路径在锁下复检即拒, 不再删除
  it('快照为公开但锁下已被隐藏, 拒绝删除且不失效缓存', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([{ id: 1, status: 1 }])

    const result = await deleteResource({ resourceId: 1 }, 7, 2)

    expect(result).toBe('未找到对应的资源')
    expect(transactionResourceDeleteMock).not.toHaveBeenCalled()
    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })

  // 隐藏行只有 admin 路径可删, 锁下重读 status=1 时公开缓存无需失效
  it('管理员删除隐藏资源不失效公开缓存', async () => {
    transactionResourceFindManyMock.mockResolvedValue([
      buildSnapshot({ status: 1 })
    ])

    await adminDeleteResource({ resourceIds: [1] }, 9)

    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })

  it('删除待审核资源失效作者的 pending 缓存而非详情缓存', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot({ status: 3 }))
    transactionQueryRawMock.mockResolvedValue([{ id: 1, status: 3 }])
    transactionResourceDeleteMock.mockResolvedValue(buildDeleted({ status: 3 }))

    await deleteResource({ resourceId: 1 }, 7, 3)

    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(invalidateUserPendingResourceCacheMock).toHaveBeenCalledWith(7)
  })

  // 管理端无守卫: 锁下重读为 0 (并发 approve 已提交) 即失效详情而非 pending
  it('管理员删除同样按锁下重读的删除瞬间状态判定', async () => {
    transactionResourceFindManyMock.mockResolvedValue([
      buildSnapshot({ status: 0 })
    ])

    await adminDeleteResource({ resourceIds: [1] }, 9)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserPendingResourceCacheMock).not.toHaveBeenCalled()
  })
})

// S3 入队与审计的事实源是行锁下重读的集合: 事务外快照与行锁之间的并发重绑会
// 换 s3_key, 级联删除绕过应用层, 用快照入队会让新对象永不进删除出箱
describe('资源删除以锁下重读的 links 入队 S3 删除', () => {
  it('入队集合来自锁下 findMany 而非事务外快照', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionLinkFindManyMock.mockResolvedValue([
      { storage: 's3', content: 'new-c', hash: 'new-h', s3_key: 'new-k' },
      { storage: 'user', content: 'u', hash: '', s3_key: '' }
    ])
    transactionResourceDeleteMock.mockResolvedValue(buildDeleted())

    await deleteResource({ resourceId: 1 }, 7, 2)

    expect(enqueueResourceLinkDeletionsMock).toHaveBeenCalledWith(
      transactionClient,
      [{ content: 'new-c', patchId: 10, hash: 'new-h', s3Key: 'new-k' }]
    )
  })

  // 扣分先于行锁 (锁序 user → patch_resource 与 moderation apply 一致), 锁下行
  // 消失走 throw 回滚而非 return: 提交型返回会落下误扣
  it('锁下行已被并发删除, 返回业务错误且不提交删除副作用', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([])

    const result = await deleteResource({ resourceId: 1 }, 7, 2)

    expect(result).toBe('未找到对应的资源')
    expect(transactionResourceDeleteMock).not.toHaveBeenCalled()
    expect(enqueueResourceLinkDeletionsMock).not.toHaveBeenCalled()
    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(kickS3DeletionDrainMock).not.toHaveBeenCalled()
  })

  it('管理员删除的入队与审计都取锁下重读的行', async () => {
    const lockedLinks = [
      { storage: 's3', content: 'cur-c', hash: 'cur-h', s3_key: 'cur-k' }
    ]
    transactionResourceFindManyMock.mockResolvedValue([
      buildSnapshot({ name: 'renamed', links: lockedLinks })
    ])

    await adminDeleteResource({ resourceIds: [1] }, 9)

    expect(enqueueResourceLinkDeletionsMock).toHaveBeenCalledWith(
      transactionClient,
      [{ content: 'cur-c', patchId: 10, hash: 'cur-h', s3Key: 'cur-k' }]
    )
    expect(sanitizeResourceLinksForAuditLogMock).toHaveBeenCalledWith(
      lockedLinks
    )
    expect(
      transactionAdminLogCreateMock.mock.calls[0][0].data.content
    ).toContain('renamed')
  })

  it('管理员删除在锁下行消失时同样零写入', async () => {
    transactionQueryRawMock.mockResolvedValue([])

    const result = await adminDeleteResource({ resourceIds: [1] }, 9)

    expect(result).toBe('未找到对应的资源')
    expect(transactionResourceDeleteManyMock).not.toHaveBeenCalled()
    expect(transactionAdminLogCreateMock).not.toHaveBeenCalled()
    expect(kickS3DeletionDrainMock).not.toHaveBeenCalled()
  })
})

// 举报外键 SET NULL: 资源行删除后按 NULL 目标清理级联置空的孤儿 (锁序一致)
describe('资源删除清理其评论的 pending 举报', () => {
  it('用户删除: cleanup 在删除前, 孤儿举报清理在删除后', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionResourceDeleteMock.mockResolvedValue(buildDeleted())

    await deleteResource({ resourceId: 1 }, 7, 2)

    expect(
      cleanupResourceCommentDerivativesMock.mock.invocationCallOrder[0]
    ).toBeLessThan(transactionResourceDeleteMock.mock.invocationCallOrder[0])
    expect(deleteOrphanReportsMock).toHaveBeenCalledWith(
      'comment',
      transactionClient
    )
    expect(
      transactionResourceDeleteMock.mock.invocationCallOrder[0]
    ).toBeLessThan(deleteOrphanReportsMock.mock.invocationCallOrder[0])
  })

  it('管理员删除: 同款清理顺序', async () => {
    await adminDeleteResource({ resourceIds: [1] }, 9)

    expect(
      cleanupResourceCommentDerivativesMock.mock.invocationCallOrder[0]
    ).toBeLessThan(
      transactionResourceDeleteManyMock.mock.invocationCallOrder[0]
    )
    expect(deleteOrphanReportsMock).toHaveBeenCalledWith(
      'comment',
      transactionClient
    )
    expect(
      transactionResourceDeleteManyMock.mock.invocationCallOrder[0]
    ).toBeLessThan(deleteOrphanReportsMock.mock.invocationCallOrder[0])
  })
})

// cleanupResourceCommentDerivatives 只清该资源「评论」的申诉; 资源行自身的申诉
// content_id 无外键、挂的 task 是 rejected 态, 级联与 deletePendingModerationTasks
// 都带不走, 须在删除方显式清理
describe('资源删除清理资源自身的 pending 申诉', () => {
  it('用户删除: 行删除后清理该资源的 pending 申诉', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionResourceDeleteMock.mockResolvedValue(buildDeleted())

    await deleteResource({ resourceId: 1 }, 7, 2)

    expect(deletePendingModerationTasksMock).toHaveBeenCalledWith(
      'resource',
      1,
      transactionClient
    )
    expect(deletePendingAppealsMock).toHaveBeenCalledWith(
      'resource',
      1,
      transactionClient
    )
    expect(
      transactionResourceDeleteMock.mock.invocationCallOrder[0]
    ).toBeLessThan(deletePendingAppealsMock.mock.invocationCallOrder[0])
  })
})
