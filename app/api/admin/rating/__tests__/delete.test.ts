import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findRatingsMock,
  findAdminMock,
  transactionMock,
  executeRawMock,
  isConflictMock,
  queryRawMock,
  deleteManyMock,
  createLogMock,
  recomputeManyMock,
  recomputeOneMock,
  deleteTasksMock,
  deleteAppealsMock,
  deleteOrphanReportsMock
} = vi.hoisted(() => ({
  findRatingsMock: vi.fn(),
  findAdminMock: vi.fn(),
  transactionMock: vi.fn(),
  executeRawMock: vi.fn(),
  isConflictMock: vi.fn(),
  queryRawMock: vi.fn(),
  deleteManyMock: vi.fn(),
  createLogMock: vi.fn(),
  recomputeManyMock: vi.fn(),
  recomputeOneMock: vi.fn(),
  deleteTasksMock: vi.fn(),
  deleteAppealsMock: vi.fn(),
  deleteOrphanReportsMock: vi.fn()
}))

const transactionClient = {
  $executeRaw: executeRawMock,
  $queryRaw: queryRawMock,
  patch_rating: { deleteMany: deleteManyMock },
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  isPrismaTransactionConflict: isConflictMock,
  prisma: {
    patch_rating: { findMany: findRatingsMock },
    user: { findUnique: findAdminMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/rating/stat', () => ({
  recomputePatchRatingStats: recomputeManyMock,
  recomputePatchRatingStat: recomputeOneMock
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: deleteTasksMock
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: deleteAppealsMock
}))

vi.mock('~/server/report/pending', () => ({
  deleteOrphanReports: deleteOrphanReportsMock
}))

import { deleteRating } from '~/app/api/admin/rating/delete'

const created = new Date('2026-01-01T00:00:00.000Z')
const rating = (id: number, patchId: number, status: number) => ({
  id,
  recommend: 'yes',
  overall: 8,
  play_status: 'finished_main',
  short_summary: `rating-${id}`,
  spoiler_level: 'none',
  status,
  user_id: id + 100,
  patch_id: patchId,
  created,
  updated: created
})

const getJoinedValues = (call: unknown[]) => {
  const joined = call.find(
    (value): value is { values: unknown[] } =>
      typeof value === 'object' &&
      value !== null &&
      'values' in value &&
      Array.isArray(value.values)
  )
  return joined?.values
}

beforeEach(() => {
  vi.clearAllMocks()
  isConflictMock.mockReturnValue(true)
  executeRawMock.mockResolvedValue(1)
  findRatingsMock.mockResolvedValue([
    rating(1, 10, 2),
    rating(2, 10, 0),
    rating(3, 20, 0),
    rating(4, 30, 2)
  ])
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  queryRawMock.mockResolvedValue([
    { id: 1, patch_id: 10, status: 0 },
    { id: 2, patch_id: 10, status: 0 },
    { id: 3, patch_id: 20, status: 2 },
    { id: 4, patch_id: 30, status: 2 }
  ])
  deleteManyMock.mockResolvedValue({ count: 4 })
  createLogMock.mockResolvedValue({})
  recomputeManyMock.mockResolvedValue(undefined)
  recomputeOneMock.mockResolvedValue(undefined)
  deleteTasksMock.mockResolvedValue(undefined)
  deleteAppealsMock.mockResolvedValue(undefined)
  deleteOrphanReportsMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('deleteRating', () => {
  it('locks target ratings and recomputes only currently visible patches in the delete transaction', async () => {
    await expect(
      deleteRating({ ratingIds: [1, 2, 3, 4] }, 99)
    ).resolves.toEqual({})

    // 举报外键 SET NULL: 删除后按 NULL 目标清理级联置空的孤儿 (锁序一致)
    expect(deleteOrphanReportsMock).toHaveBeenCalledWith(
      'rating',
      transactionClient
    )
    expect(deleteManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteOrphanReportsMock.mock.invocationCallOrder[0]
    )

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    const patchLockSql = (
      executeRawMock.mock.calls[0][0] as TemplateStringsArray
    )
      .join('?')
      .replace(/\s+/g, ' ')
      .trim()
    expect(patchLockSql).toContain('FROM patch')
    expect(patchLockSql).toContain('ORDER BY id')
    expect(patchLockSql).toContain('FOR KEY SHARE')
    expect(getJoinedValues(executeRawMock.mock.calls[0])).toEqual([10, 20, 30])

    expect(queryRawMock).toHaveBeenCalledTimes(1)
    const sql = (queryRawMock.mock.calls[0][0] as TemplateStringsArray)
      .join('?')
      .replace(/\s+/g, ' ')
      .trim()
    expect(sql).toContain('FROM patch_rating')
    expect(sql).toContain('FOR UPDATE')
    expect(sql).toContain('ORDER BY id')
    expect(getJoinedValues(queryRawMock.mock.calls[0])).toEqual([1, 2, 3, 4])

    expect(recomputeManyMock).toHaveBeenCalledWith([10, 10], transactionClient)
    expect(recomputeOneMock).not.toHaveBeenCalled()
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      queryRawMock.mock.invocationCallOrder[0]
    )
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteManyMock.mock.invocationCallOrder[0]
    )
    expect(deleteManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      recomputeManyMock.mock.invocationCallOrder[0]
    )
  })
  it('retries PostgreSQL deadlocks surfaced by raw query', async () => {
    const conflictError = Object.assign(new Error('raw query failed'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: { kind: 'postgres', originalCode: '40P01' }
        }
      }
    })
    let attempt = 0
    transactionMock.mockImplementation(
      async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
        const result = await callback(transactionClient)
        attempt++
        if (attempt === 1) {
          throw conflictError
        }
        return result
      }
    )

    await expect(
      deleteRating({ ratingIds: [1, 2, 3, 4] }, 99)
    ).resolves.toEqual({})

    expect(findRatingsMock).toHaveBeenCalledTimes(1)
    expect(transactionMock).toHaveBeenCalledTimes(2)
    expect(recomputeManyMock).toHaveBeenCalledTimes(2)
  })
})
