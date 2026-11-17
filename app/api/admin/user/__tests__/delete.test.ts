import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUserMock,
  findResourcesMock,
  countResourcesMock,
  findRatingsMock,
  findRatingsInTransactionMock,
  transactionMock,
  executeRawMock,
  isConflictMock,
  queryRawMock,
  deleteUserMock,
  createLogMock,
  deleteResourceMock,
  recomputeManyMock,
  recomputeOneMock,
  deleteTokenMock,
  invalidateCacheMock,
  invalidateTagCacheMock,
  invalidateCompanyCacheMock,
  findCommentedPatchesMock,
  invalidateCommentCacheMock,
  invalidateResourceDetailMock,
  findResourcesInTransactionMock,
  recalcPatchTypeMock,
  enqueueSearchOutboxMock,
  kickDrainMock,
  invalidatePatchContentCacheMock,
  invalidateContentByPatchIdMock,
  deleteOrphanReportsMock,
  findOwnPatchesMock,
  findCommentsInTransactionMock,
  enqueueLinkDeletionsMock,
  deletePendingTasksMock,
  deletePendingAppealsMock,
  kickS3DrainMock
} = vi.hoisted(() => ({
  findUserMock: vi.fn(),
  findResourcesMock: vi.fn(),
  countResourcesMock: vi.fn(),
  findRatingsMock: vi.fn(),
  findRatingsInTransactionMock: vi.fn(),
  transactionMock: vi.fn(),
  executeRawMock: vi.fn(),
  isConflictMock: vi.fn(),
  queryRawMock: vi.fn(),
  deleteUserMock: vi.fn(),
  createLogMock: vi.fn(),
  deleteResourceMock: vi.fn(),
  recomputeManyMock: vi.fn(),
  recomputeOneMock: vi.fn(),
  deleteTokenMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
  invalidateTagCacheMock: vi.fn(),
  invalidateCompanyCacheMock: vi.fn(),
  findCommentedPatchesMock: vi.fn(),
  invalidateCommentCacheMock: vi.fn(),
  invalidateResourceDetailMock: vi.fn(),
  findResourcesInTransactionMock: vi.fn(),
  recalcPatchTypeMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn(),
  kickDrainMock: vi.fn(),
  invalidatePatchContentCacheMock: vi.fn(),
  invalidateContentByPatchIdMock: vi.fn(),
  deleteOrphanReportsMock: vi.fn(),
  findOwnPatchesMock: vi.fn(),
  findCommentsInTransactionMock: vi.fn(),
  enqueueLinkDeletionsMock: vi.fn(),
  deletePendingTasksMock: vi.fn(),
  deletePendingAppealsMock: vi.fn(),
  kickS3DrainMock: vi.fn()
}))

const events: string[] = []
const transactionClient = {
  $executeRaw: executeRawMock,
  $queryRaw: queryRawMock,
  patch: { findMany: findOwnPatchesMock },
  patch_rating: { findMany: findRatingsInTransactionMock },
  patch_resource: { findMany: findResourcesInTransactionMock },
  patch_comment: { findMany: findCommentsInTransactionMock },
  user: { delete: deleteUserMock },
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  isPrismaTransactionConflict: isConflictMock,
  prisma: {
    user: { findUnique: findUserMock },
    patch_resource: {
      findMany: findResourcesMock,
      count: countResourcesMock
    },
    patch_rating: { findMany: findRatingsMock },
    patch_comment: { findMany: findCommentedPatchesMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/jwt', () => ({
  deleteKunToken: deleteTokenMock
}))

vi.mock('~/app/api/admin/resource/delete', () => ({
  deleteResource: deleteResourceMock
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: invalidateCacheMock
}))

vi.mock('~/app/api/tag/cache', () => ({
  invalidateTagListCache: invalidateTagCacheMock
}))

vi.mock('~/app/api/company/cache', () => ({
  invalidateCompanyListCache: invalidateCompanyCacheMock
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: invalidateCommentCacheMock
}))

vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: invalidateResourceDetailMock
}))

vi.mock('~/app/api/patch/rating/stat', () => ({
  recomputePatchRatingStats: recomputeManyMock,
  recomputePatchRatingStat: recomputeOneMock
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  recalcPatchType: recalcPatchTypeMock,
  enqueueResourceLinkDeletions: enqueueLinkDeletionsMock
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: deletePendingTasksMock
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: deletePendingAppealsMock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: kickS3DrainMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidatePatchContentCacheMock,
  invalidatePatchContentCacheByPatchId: invalidateContentByPatchIdMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock,
  kickSearchOutboxDrain: kickDrainMock
}))

vi.mock('~/server/report/pending', () => ({
  deleteOrphanReports: deleteOrphanReportsMock
}))

import { deleteUser } from '~/app/api/admin/user/delete'

beforeEach(() => {
  vi.clearAllMocks()
  isConflictMock.mockReturnValue(true)
  events.length = 0
  findUserMock
    .mockResolvedValueOnce({
      id: 7,
      name: 'target',
      email: 'target@example.com',
      role: 1,
      status: 0
    })
    .mockResolvedValueOnce({ id: 99, name: 'admin' })
  findResourcesMock.mockResolvedValue([])
  countResourcesMock.mockResolvedValue(1)
  findRatingsMock.mockResolvedValue([
    { patch_id: 10 },
    { patch_id: 11 },
    { patch_id: 12 }
  ])
  findRatingsInTransactionMock.mockResolvedValue([
    { patch_id: 10, status: 0, patch: { user_id: 100 } },
    { patch_id: 11, status: 0, patch: { user_id: 7 } },
    { patch_id: 12, status: 2, patch: { user_id: 100 } }
  ])
  findResourcesInTransactionMock.mockResolvedValue([])
  findOwnPatchesMock.mockResolvedValue([])
  findCommentsInTransactionMock.mockResolvedValue([])
  enqueueLinkDeletionsMock.mockImplementation(async () => {
    events.push('enqueue-s3-links')
  })
  deletePendingTasksMock.mockImplementation(async (type: string) => {
    events.push(`delete-tasks-${type}`)
  })
  deletePendingAppealsMock.mockImplementation(async (type: string) => {
    events.push(`delete-appeals-${type}`)
  })
  kickS3DrainMock.mockImplementation(() => {
    events.push('kick-s3-drain')
  })
  recalcPatchTypeMock.mockImplementation(async (patchId: number) => {
    events.push(`recalc-${patchId}`)
    return `uid-${patchId}`
  })
  enqueueSearchOutboxMock.mockImplementation(
    async (_client: unknown, patchId: number) => {
      events.push(`enqueue-${patchId}`)
    }
  )
  kickDrainMock.mockImplementation(() => {
    events.push('kick-drain')
  })
  executeRawMock.mockResolvedValue(1)
  queryRawMock.mockResolvedValue([
    { id: 1, patch_id: 10, status: 0, patch_user_id: 100 },
    { id: 2, patch_id: 11, status: 0, patch_user_id: 7 },
    { id: 3, patch_id: 12, status: 2, patch_user_id: 100 }
  ])
  deleteUserMock.mockImplementation(async () => {
    events.push('delete-user')
    return {}
  })
  deleteOrphanReportsMock.mockImplementation(async () => {
    events.push('delete-orphan-reports')
  })
  createLogMock.mockResolvedValue({})
  deleteResourceMock.mockResolvedValue({})
  recomputeManyMock.mockImplementation(async () => {
    events.push('recompute-many')
  })
  recomputeOneMock.mockImplementation(async () => {
    events.push('recompute-one')
  })
  deleteTokenMock.mockImplementation(async () => {
    events.push('delete-token')
  })
  invalidateCacheMock.mockImplementation(async () => {
    events.push('invalidate-cache')
  })
  invalidateTagCacheMock.mockImplementation(async () => {
    events.push('invalidate-tag-cache')
  })
  invalidateCompanyCacheMock.mockImplementation(async () => {
    events.push('invalidate-company-cache')
  })
  findCommentedPatchesMock.mockResolvedValue([{ patch_id: 20 }])
  invalidateCommentCacheMock.mockImplementation(async () => {
    events.push('invalidate-comment-cache')
  })
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  invalidateContentByPatchIdMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      events.push('transaction-start')
      const result = await callback(transactionClient)
      events.push('transaction-end')
      return result
    }
  )
})

describe('deleteUser', () => {
  it('uses a serializable snapshot before atomically recomputing surviving visible patches', async () => {
    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 60000,
      isolationLevel: 'Serializable'
    })
    expect(executeRawMock).not.toHaveBeenCalled()
    expect(queryRawMock).not.toHaveBeenCalled()
    expect(findRatingsMock).not.toHaveBeenCalled()
    expect(findRatingsInTransactionMock).toHaveBeenCalledWith({
      where: { user_id: 7 },
      select: {
        patch_id: true,
        status: true,
        patch: { select: { user_id: true } }
      }
    })

    expect(recomputeManyMock).toHaveBeenCalledWith([10], transactionClient)
    expect(recomputeOneMock).not.toHaveBeenCalled()
    // 孤儿举报清理在事务内、级联删除之后 (删除前清理与级联 SET NULL 锁序相反会死锁)
    expect(deleteOrphanReportsMock).toHaveBeenCalledWith(
      'comment',
      transactionClient
    )
    expect(events).toEqual([
      'transaction-start',
      'delete-user',
      'delete-orphan-reports',
      'recompute-many',
      'transaction-end',
      'invalidate-tag-cache',
      'invalidate-company-cache',
      'delete-token',
      'invalidate-cache',
      'invalidate-comment-cache',
      'kick-drain'
    ])
  })

  it('recomputes and re-syncs surviving patches whose non-s3 resources cascade away', async () => {
    // 他人 (user_id !== 7) 补丁下、无 S3 link 的资源: 只随 user.delete() 级联消失,
    // S3 收集看不到它们. 返回乱序以验证按 patch_id 排序取通告锁 (确定性锁序)
    findResourcesInTransactionMock.mockResolvedValue([
      { patch_id: 32 },
      { patch_id: 30 }
    ])

    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    expect(findResourcesInTransactionMock).toHaveBeenCalledWith({
      where: { user_id: 7, patch: { user_id: { not: 7 } } },
      select: { patch_id: true },
      distinct: ['patch_id']
    })
    // 事务内、级联删除后按升序重算, 每次都用事务客户端持通告锁
    expect(recalcPatchTypeMock.mock.calls).toEqual([
      [30, transactionClient],
      [32, transactionClient]
    ])
    // 事务内逐 id 入队（与重算同循环、同事务，原子提交）
    expect(enqueueSearchOutboxMock.mock.calls).toEqual([
      [transactionClient, 30],
      [transactionClient, 32]
    ])
    // M-04: 事务提交后按 unique_id 失效 patch 内容缓存 (提交前失效会被并发读回填旧值)
    expect(invalidatePatchContentCacheMock.mock.calls).toEqual([
      ['uid-30'],
      ['uid-32']
    ])
    // 事务提交后仅一次 kick 触发 drain 处理整箱（不再逐 id 各 kick）
    expect(kickDrainMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      'transaction-start',
      'delete-user',
      'delete-orphan-reports',
      'recompute-many',
      'recalc-30',
      'enqueue-30',
      'recalc-32',
      'enqueue-32',
      'transaction-end',
      'invalidate-tag-cache',
      'invalidate-company-cache',
      'delete-token',
      'invalidate-cache',
      'invalidate-comment-cache',
      'kick-drain'
    ])
  })

  it('失效级联删除的评论与评分所在 patch 的详情缓存 (M-05)', async () => {
    findCommentedPatchesMock.mockResolvedValue([
      { patch_id: 40 },
      { patch_id: 41 }
    ])
    findRatingsInTransactionMock.mockResolvedValue([
      { patch_id: 50, status: 0, patch: { user_id: 8 } },
      { patch_id: 51, status: 2, patch: { user_id: 8 } },
      { patch_id: 52, status: 0, patch: { user_id: 7 } }
    ])

    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    // 评论 patch (40,41) + 他人补丁下 status=0 评分 patch (50); 隐藏(51)与自己补丁(52)排除
    expect(invalidateContentByPatchIdMock).toHaveBeenCalledWith([40, 41, 50])
  })

  it('失效被删用户点赞过的他人 patch 资源详情缓存, 不受资源计数闸门约束', async () => {
    countResourcesMock.mockResolvedValue(0)
    findResourcesMock.mockImplementation(
      async (query?: { where?: { like_by?: unknown } }) => {
        if (query?.where?.like_by) {
          events.push('collect-liked')
          return [{ patch_id: 60 }, { patch_id: 61 }]
        }
        return []
      }
    )

    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    expect(findResourcesMock).toHaveBeenCalledWith({
      where: {
        like_by: { some: { user_id: 7 } },
        status: 0,
        patch: { user_id: { not: 7 } }
      },
      select: { patch_id: true },
      distinct: ['patch_id']
    })
    // 零公开资源时列表失效闸门关闭, 但点赞侧详情失效仍须执行
    expect(invalidateCacheMock).not.toHaveBeenCalled()
    expect(invalidateResourceDetailMock.mock.calls).toEqual([[60], [61]])
    // 点赞收集必须先于删除事务: like_by 随 user.delete() 级联消失, 挪到事务后恒空
    const likedIdx = events.indexOf('collect-liked')
    expect(likedIdx).toBeGreaterThanOrEqual(0)
    expect(likedIdx).toBeLessThan(events.indexOf('transaction-start'))
  })

  it('点赞 patch 与资源受影响集重叠时只失效一次', async () => {
    findResourcesInTransactionMock.mockResolvedValue([
      { patch_id: 32 },
      { patch_id: 30 }
    ])
    findResourcesMock.mockImplementation(
      async (query?: { where?: { like_by?: unknown } }) =>
        query?.where?.like_by ? [{ patch_id: 32 }, { patch_id: 70 }] : []
    )

    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    // 32 已由 affectedPatchIds 闸门内失效, 点赞侧仅补 70
    expect(invalidateResourceDetailMock.mock.calls).toEqual([[30], [32], [70]])
  })

  // 删号前清该用户带 S3 链接的资源: 逐条各开一个事务, 不合成一批。合批会让一个
  // 长事务同时持有这个用户全部资源行的锁
  it('该用户带 S3 链接的资源逐条删除, 每条单独一次调用', async () => {
    findResourcesMock.mockImplementation(
      async (query?: { where?: { links?: unknown } }) =>
        query?.where?.links ? [{ id: 55 }, { id: 56 }, { id: 57 }] : []
    )

    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    expect(deleteResourceMock.mock.calls).toEqual([
      [{ resourceIds: [55] }, 99],
      [{ resourceIds: [56] }, 99],
      [{ resourceIds: [57] }, 99]
    ])
  })

  it('retries serializable conflicts without repeating resource cleanup', async () => {
    // S3 收集返回 55; 点赞收集共用同一 findMany mock, 按 where 形状区分返回空
    findResourcesMock.mockImplementation(
      async (query?: { where?: { links?: unknown } }) =>
        query?.where?.links ? [{ id: 55 }] : []
    )
    // 首次尝试(将因冲突回滚)与重试各收集到不同的受影响 patch
    findResourcesInTransactionMock
      .mockResolvedValueOnce([{ patch_id: 91 }])
      .mockResolvedValueOnce([{ patch_id: 92 }])
    let attempt = 0
    transactionMock.mockImplementation(
      async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
        const result = await callback(transactionClient)
        attempt++
        if (attempt === 1) {
          throw Object.assign(new Error('write conflict'), { code: 'P2034' })
        }
        return result
      }
    )

    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    expect(deleteResourceMock).toHaveBeenCalledTimes(1)
    expect(transactionMock).toHaveBeenCalledTimes(2)
    expect(deleteUserMock).toHaveBeenCalledTimes(2)
    // 清理随每次 attempt 在事务内执行 (deleteMany 幂等, 重试安全)
    expect(deleteOrphanReportsMock).toHaveBeenCalledTimes(2)
    expect(deleteTokenMock).toHaveBeenCalledTimes(1)
    // recalcPatchType 与 enqueueSearchOutbox 事务内两次尝试各跑一次; 首次尝试(91)
    // 的入队在回滚事务内、随事务一并丢弃(与 recalc 同), 不泄漏靠事务原子性
    expect(recalcPatchTypeMock.mock.calls).toEqual([
      [91, transactionClient],
      [92, transactionClient]
    ])
    expect(enqueueSearchOutboxMock.mock.calls).toEqual([
      [transactionClient, 91],
      [transactionClient, 92]
    ])
    // 事务后 kick 仅一次(不随重试次数增加)
    expect(kickDrainMock).toHaveBeenCalledTimes(1)
    // Serializable 重试仅提交最终 attempt: 缓存失效不含被回滚 attempt 的 uid-91
    expect(invalidatePatchContentCacheMock.mock.calls).toEqual([['uid-92']])
  })

  it('invalidates cascading lists before token cleanup can fail', async () => {
    deleteTokenMock.mockImplementation(async () => {
      events.push('delete-token')
      throw new Error('redis down')
    })

    await expect(deleteUser({ uid: 7 }, 99)).rejects.toThrow('redis down')

    expect(invalidateTagCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateCompanyCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateCacheMock).not.toHaveBeenCalled()
    expect(events.slice(-3)).toEqual([
      'invalidate-tag-cache',
      'invalidate-company-cache',
      'delete-token'
    ])
  })

  it('does not invalidate list caches when the transaction fails', async () => {
    isConflictMock.mockReturnValue(false)
    transactionMock.mockRejectedValue(new Error('database down'))

    await expect(deleteUser({ uid: 7 }, 99)).rejects.toThrow('database down')

    expect(invalidateCacheMock).not.toHaveBeenCalled()
    expect(invalidateTagCacheMock).not.toHaveBeenCalled()
    expect(invalidateCompanyCacheMock).not.toHaveBeenCalled()
    expect(invalidatePatchContentCacheMock).not.toHaveBeenCalled()
  })

  it('级联删除自有 patch 前锁下收集他人资源, 复用 deletePatchById 清理序列', async () => {
    // 自有 patch 乱序返回, 验证锁语句与搜索入箱按升序 (确定性锁序)
    findOwnPatchesMock.mockResolvedValue([
      { id: 81, unique_id: 'own-81' },
      { id: 80, unique_id: 'own-80' }
    ])
    // 锁下重读 (patch_id in) 与他人 patch 上本人资源 (user_id) 两种形状区分
    findResourcesInTransactionMock.mockImplementation(
      async (query?: { where?: { patch_id?: unknown } }) => {
        if (query?.where?.patch_id) {
          events.push('read-own-resources')
          return [
            {
              id: 301,
              patch_id: 80,
              status: 0,
              section: 'patch',
              links: [
                { storage: 's3', content: 'c1', hash: 'h1', s3_key: 'k1' },
                { storage: 'user', content: 'c2', hash: 'h2', s3_key: '' }
              ]
            },
            { id: 302, patch_id: 81, status: 1, section: 'patch', links: [] }
          ]
        }
        return []
      }
    )
    findRatingsInTransactionMock.mockImplementation(
      async (query?: { where?: { patch_id?: unknown } }) =>
        query?.where?.patch_id ? [{ id: 501 }] : []
    )
    findCommentsInTransactionMock.mockResolvedValue([{ id: 401 }])
    queryRawMock.mockImplementation(async () => {
      events.push('lock-own-resources')
      return []
    })

    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    // 单语句升序取锁, 先于锁下重读、重读先于级联删除
    expect(queryRawMock).toHaveBeenCalledTimes(1)
    const [template, boundIds] = queryRawMock.mock.calls[0]
    expect(template.join('?')).toContain('FOR UPDATE')
    expect(boundIds).toEqual([80, 81])
    expect(events.indexOf('lock-own-resources')).toBeLessThan(
      events.indexOf('read-own-resources')
    )
    expect(events.indexOf('read-own-resources')).toBeLessThan(
      events.indexOf('delete-user')
    )
    // 评论/评分 id 也须在级联删除前收集 (content_id 无外键, 删除后无从得知)
    expect(findCommentsInTransactionMock).toHaveBeenCalledWith({
      where: { patch_id: { in: [80, 81] } },
      select: { id: true }
    })
    // 只入队 storage='s3' 的 link, 保留 hash/s3Key
    expect(enqueueLinkDeletionsMock).toHaveBeenCalledWith(transactionClient, [
      { content: 'c1', patchId: 80, hash: 'h1', s3Key: 'k1' }
    ])
    // 他人 pending 审核任务/申诉按三类 content id 清理, 均在级联删除之后
    expect(deletePendingTasksMock.mock.calls).toEqual([
      ['comment', [401], transactionClient],
      ['rating', [501], transactionClient],
      ['resource', [301, 302], transactionClient]
    ])
    expect(deletePendingAppealsMock.mock.calls).toEqual([
      ['comment', [401], transactionClient],
      ['rating', [501], transactionClient],
      ['resource', [301, 302], transactionClient]
    ])
    expect(events.indexOf('delete-user')).toBeLessThan(
      events.indexOf('delete-tasks-comment')
    )
    // 自有 patch 升序入搜索出箱
    expect(enqueueSearchOutboxMock.mock.calls).toEqual([
      [transactionClient, 80],
      [transactionClient, 81]
    ])
    // 提交后: 自有 patch content 缓存失效 + S3 出箱 kick
    expect(invalidatePatchContentCacheMock.mock.calls).toEqual([
      ['own-81'],
      ['own-80']
    ])
    expect(kickS3DrainMock).toHaveBeenCalledTimes(1)
    expect(events.indexOf('kick-s3-drain')).toBeGreaterThan(
      events.indexOf('transaction-end')
    )
  })

  it('本人零公开资源但自有 patch 有他人公开资源时仍失效资源列表缓存', async () => {
    countResourcesMock.mockResolvedValue(0)
    findOwnPatchesMock.mockResolvedValue([{ id: 80, unique_id: 'own-80' }])
    findResourcesInTransactionMock.mockImplementation(
      async (query?: { where?: { patch_id?: unknown } }) =>
        query?.where?.patch_id
          ? [{ id: 301, patch_id: 80, status: 0, section: 'patch', links: [] }]
          : []
    )
    findRatingsInTransactionMock.mockResolvedValue([])

    await expect(deleteUser({ uid: 7 }, 99)).resolves.toEqual({})

    // publicResourceCount=0 闸门关闭, 他人公开资源旗标独立驱动列表失效
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1)
    // 无 S3 link 时入箱空集 (enqueueS3Deletion 内部早退), 不 kick S3 drain
    expect(enqueueLinkDeletionsMock).toHaveBeenCalledWith(transactionClient, [])
    expect(kickS3DrainMock).not.toHaveBeenCalled()
  })
})
