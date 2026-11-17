import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUniqueMock,
  createMock,
  transactionMock,
  recomputeMock,
  preScreenMock,
  createTaskMock,
  invalidateContentMock
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
  transactionMock: vi.fn(),
  recomputeMock: vi.fn(async () => undefined),
  preScreenMock: vi.fn(),
  createTaskMock: vi.fn(async () => undefined),
  invalidateContentMock: vi.fn(async () => undefined)
}))

const tx = { patch_rating: { create: createMock } }

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
  enqueueTextModeration: createTaskMock,
  planTextModeration: preScreenMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock
}))

import { createPatchRating } from '~/app/api/patch/rating/create'

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
