import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findRatingMock,
  findAdminMock,
  transactionMock,
  updateRatingMock,
  createLogMock
} = vi.hoisted(() => ({
  findRatingMock: vi.fn(),
  findAdminMock: vi.fn(),
  transactionMock: vi.fn(),
  updateRatingMock: vi.fn(),
  createLogMock: vi.fn()
}))

const transactionClient = {
  patch_rating: { update: updateRatingMock },
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_rating: { findUnique: findRatingMock },
    user: { findUnique: findAdminMock },
    $transaction: transactionMock
  }
}))

import { updateRating } from '~/app/api/admin/rating/update'

const created = new Date('2026-01-01T00:00:00.000Z')

beforeEach(() => {
  vi.resetAllMocks()
  findRatingMock.mockResolvedValue({
    id: 1,
    recommend: 'yes',
    overall: 8,
    play_status: 'finished_main',
    short_summary: 'old',
    spoiler_level: 'none',
    status: 0,
    user_id: 101,
    patch_id: 10,
    created,
    updated: created
  })
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  updateRatingMock.mockResolvedValue({})
  createLogMock.mockResolvedValue({})
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('updateRating', () => {
  it('updates only short_summary without loading relations', async () => {
    await expect(
      updateRating({ ratingId: 1, shortSummary: 'new' }, 99)
    ).resolves.toEqual({})

    // 返回值无人消费, 参数整体精确匹配: 多出 include 等键即失败
    expect(updateRatingMock).toHaveBeenCalledTimes(1)
    expect(updateRatingMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { short_summary: 'new' }
    })

    expect(createLogMock).toHaveBeenCalledTimes(1)
  })

  it('returns an error message when the rating does not exist', async () => {
    findRatingMock.mockResolvedValue(null)

    await expect(
      updateRating({ ratingId: 1, shortSummary: 'new' }, 99)
    ).resolves.toBe('未找到对应的评价')
    expect(transactionMock).not.toHaveBeenCalled()
  })
})
