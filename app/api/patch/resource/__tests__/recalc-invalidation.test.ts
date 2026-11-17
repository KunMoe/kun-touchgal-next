import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transactionMock, invalidatePatchContentCacheMock } = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  invalidatePatchContentCacheMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { $transaction: transactionMock }
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidatePatchContentCacheMock
}))

vi.mock('~/lib/redis', () => ({
  acquireKvLock: vi.fn(),
  delKv: vi.fn(),
  getKv: vi.fn(),
  releaseKvLock: vi.fn()
}))

vi.mock('~/lib/s3', () => ({
  copyObject: vi.fn(),
  deleteFileFromS3: vi.fn(),
  headObject: vi.fn()
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  enqueueS3Deletion: vi.fn()
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

import { recalcPatchType } from '~/app/api/patch/resource/_helper'

const makeTx = (uniqueId = 'abcd1234') => ({
  $executeRaw: vi.fn().mockResolvedValue(1),
  patch_resource: {
    findMany: vi
      .fn()
      .mockResolvedValue([
        { type: ['galgame'], language: ['zh-Hans'], platform: ['windows'] }
      ])
  },
  patch: {
    update: vi.fn().mockResolvedValue({ unique_id: uniqueId })
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
})

describe('recalcPatchType', () => {
  it('传入事务客户端时: 先锁 patch 行再取通告锁、重算聚合并返回 unique_id, 但不在事务内失效缓存 (M-04)', async () => {
    const tx = makeTx('unique01')

    const result = await recalcPatchType(1, tx as never)

    expect(result).toBe('unique01')
    // 两把锁都经 $executeRaw 取得, 随调用方事务提交/回滚释放。patch 行在前: 调用方的
    // 写语句可能已经让计数触发器拿到 patch 行锁, 反过来取会与它在两把锁上互等
    expect(
      tx.$executeRaw.mock.calls.map(([template]) =>
        (template as string[]).join('?').replace(/\s+/g, ' ').trim()
      )
    ).toEqual([
      'SELECT id FROM patch WHERE id = ANY(?::int[]) ORDER BY id FOR NO KEY UPDATE',
      'SELECT pg_advisory_xact_lock(?::int, ?::int)'
    ])
    expect(tx.$executeRaw.mock.calls[0][1]).toEqual([1])
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.patch_resource.findMany.mock.invocationCallOrder[0]
    )
    // 事务内写聚合字段
    expect(tx.patch.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        type: { set: ['galgame'] },
        language: { set: ['zh-Hans'] },
        platform: { set: ['windows'] }
      },
      select: { unique_id: true }
    })
    // 核心: 事务提交前绝不失效缓存, 否则并发读会用旧的已提交态回填
    expect(invalidatePatchContentCacheMock).not.toHaveBeenCalled()
    // 传 tx 时不自开事务
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('传入事务客户端时: 重算不碰 Redis, 缓存失效即使会抛也不参与事务 (M-04 缺陷2)', async () => {
    const tx = makeTx()
    invalidatePatchContentCacheMock.mockRejectedValue(new Error('redis down'))

    // 不抛: 重算只依赖 PostgreSQL, Redis 故障无法回滚调用方事务
    await expect(recalcPatchType(2, tx as never)).resolves.toBe('abcd1234')
    expect(invalidatePatchContentCacheMock).not.toHaveBeenCalled()
  })

  it('不传事务客户端时: 自开事务并严格在提交后才失效缓存', async () => {
    const tx = makeTx('unique02')
    const events: string[] = []
    transactionMock.mockImplementation(
      async (cb: (t: unknown) => Promise<unknown>) => {
        const r = await cb(tx)
        events.push('tx-commit')
        return r
      }
    )
    invalidatePatchContentCacheMock.mockImplementation(async () => {
      events.push('invalidate')
    })

    const result = await recalcPatchType(3)

    expect(result).toBe('unique02')
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(invalidatePatchContentCacheMock).toHaveBeenCalledWith('unique02')
    // 失效严格发生在事务提交之后
    expect(events).toEqual(['tx-commit', 'invalidate'])
  })

  it('不传事务客户端时: 提交后失效失败被吞掉, 不影响已提交的重算 (best-effort)', async () => {
    const tx = makeTx('unique03')
    transactionMock.mockImplementation((cb: (t: unknown) => Promise<unknown>) =>
      cb(tx)
    )
    invalidatePatchContentCacheMock.mockRejectedValue(new Error('redis down'))

    await expect(recalcPatchType(4)).resolves.toBe('unique03')
    expect(invalidatePatchContentCacheMock).toHaveBeenCalledWith('unique03')
  })
})
