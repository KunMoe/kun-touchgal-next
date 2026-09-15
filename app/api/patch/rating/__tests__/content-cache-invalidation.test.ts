import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUniqueMock,
  createMock,
  deleteMock,
  transactionMock,
  recomputeMock,
  preScreenMock,
  createTaskMock,
  deletePendingMock,
  deletePendingAppealsMock,
  deleteOrphanReportsMock,
  invalidateContentMock,
  invalidateByIdMock
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
  deleteMock: vi.fn(async () => undefined),
  transactionMock: vi.fn(),
  recomputeMock: vi.fn(async () => undefined),
  preScreenMock: vi.fn(),
  createTaskMock: vi.fn(async () => undefined),
  deletePendingMock: vi.fn(async () => undefined),
  deletePendingAppealsMock: vi.fn(async () => undefined),
  deleteOrphanReportsMock: vi.fn(async () => undefined),
  invalidateContentMock: vi.fn(async () => undefined),
  invalidateByIdMock: vi.fn(async () => undefined)
}))

const tx = { patch_rating: { create: createMock, delete: deleteMock } }

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_rating: { findUnique: findUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/rating/stat', () => ({
  recomputePatchRatingStat: recomputeMock
}))

vi.mock('~/server/moderation/submit', () => ({
  createModerationTask: createTaskMock,
  preScreenText: preScreenMock,
  deletePendingModerationTasks: deletePendingMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock,
  invalidatePatchContentCacheByPatchId: invalidateByIdMock
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: deletePendingAppealsMock
}))

vi.mock('~/server/report/pending', () => ({
  deleteOrphanReports: deleteOrphanReportsMock
}))

import { createPatchRating } from '~/app/api/patch/rating/create'
import { deletePatchRating } from '~/app/api/patch/rating/delete'

const created = new Date('2026-01-01T00:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  transactionMock.mockImplementation(
    async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)
  )
  preScreenMock.mockResolvedValue({
    intercept: false,
    queue: false,
    dryRun: false
  })
})

describe('createPatchRating 缓存失效 (M-05)', () => {
  it('新增评分在事务提交后按 unique_id 失效补丁详情缓存', async () => {
    findUniqueMock.mockResolvedValue(null)
    createMock.mockResolvedValue({
      id: 1,
      patch_id: 10,
      user_id: 7,
      recommend: 'yes',
      overall: 8,
      play_status: 1,
      short_summary: 's',
      spoiler_level: 0,
      status: 0,
      created,
      updated: created,
      patch: { unique_id: 'ratingpa' },
      user: { id: 7, name: 'u', avatar: '' }
    })

    const result = await createPatchRating(
      {
        patchId: 10,
        recommend: 'yes',
        overall: 8,
        playStatus: 'played',
        shortSummary: 's',
        spoilerLevel: 'none'
      },
      7,
      2
    )

    expect(recomputeMock).toHaveBeenCalledWith(10, tx)
    expect(invalidateContentMock).toHaveBeenCalledWith('ratingpa')
    expect(result).toMatchObject({ id: 1, uniqueId: 'ratingpa' })
  })
})

describe('deletePatchRating 缓存失效 (M-05)', () => {
  it('删除评分在事务提交后按 patch_id 失效补丁详情缓存', async () => {
    findUniqueMock.mockResolvedValue({
      id: 1,
      patch_id: 10,
      user_id: 7,
      status: 0
    })

    const result = await deletePatchRating({ ratingId: 1 }, 7, 1)

    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 1 } })
    expect(recomputeMock).toHaveBeenCalledWith(10, tx)
    expect(invalidateByIdMock).toHaveBeenCalledWith(10)
    expect(result).toEqual({})
  })
})

// content_id 无外键, 行删除不触发任何级联; 申诉挂的 task 是 rejected 状态,
// 不在 deletePendingModerationTasks 的删除集里, 故须在删除方显式清理
describe('deletePatchRating 清理未处理申诉', () => {
  it('删除评分在同事务内清理该评分的 pending 申诉', async () => {
    findUniqueMock.mockResolvedValue({
      id: 1,
      patch_id: 10,
      user_id: 7,
      status: 0
    })

    await deletePatchRating({ ratingId: 1 }, 7, 1)

    expect(deletePendingMock).toHaveBeenCalledWith('rating', 1, tx)
    expect(deletePendingAppealsMock).toHaveBeenCalledWith('rating', 1, tx)
    expect(deleteMock.mock.invocationCallOrder[0]).toBeLessThan(
      deletePendingAppealsMock.mock.invocationCallOrder[0]
    )
  })
})
