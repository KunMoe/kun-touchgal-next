import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  findUniqueMock,
  transactionMock,
  createMock,
  recomputeOneMock,
  planTextModerationMock,
  enqueueTextModerationMock
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  createMock: vi.fn(),
  recomputeOneMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  enqueueTextModerationMock: vi.fn()
}))

const events: string[] = []
const transactionClient = {
  patch_rating: {
    create: createMock
  }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_rating: { findUnique: findUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/rating/stat', () => ({
  recomputePatchRatingStat: recomputeOneMock
}))

vi.mock('~/server/moderation/submit', () => ({
  MODERATION_SKIP: { queue: false, intercept: false, dryRun: false },
  planTextModeration: planTextModerationMock,
  enqueueTextModeration: enqueueTextModerationMock
}))

import { ratingSubject } from '~/server/moderation/subject'
import { createPatchRating } from '~/app/api/patch/rating/create'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'

const ratingInput = {
  recommend: 'yes',
  overall: 8,
  playStatus: 'finished_main',
  shortSummary: 'summary',
  spoilerLevel: 'none'
}
const createInput = { patchId: 10, ...ratingInput }
const created = new Date('2026-01-01T00:00:00.000Z')
const rating = {
  id: 5,
  patch_id: 10,
  user_id: 7,
  recommend: 'yes',
  overall: 8,
  play_status: 'finished_main',
  short_summary: 'summary',
  spoiler_level: 'none',
  status: 0,
  created,
  updated: created,
  patch: { unique_id: 'patch-10' },
  user: { id: 7, name: 'user', avatar: 'avatar' },
  _count: { like: 0 },
  like: []
}

const prismaKnownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('constraint failed', {
    code,
    clientVersion: 'test'
  })

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  createMock.mockResolvedValue(rating)
  planTextModerationMock.mockResolvedValue({
    queue: false,
    intercept: false,
    dryRun: false
  })
  enqueueTextModerationMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      events.push('transaction-start')
      try {
        const result = await callback(transactionClient)
        events.push('transaction-commit')
        return result
      } catch (error) {
        events.push('transaction-rollback')
        throw error
      }
    }
  )
  recomputeOneMock.mockImplementation(
    async (patchId: number, tx: typeof transactionClient) => {
      expect(patchId).toBe(10)
      expect(tx).toBe(transactionClient)
      events.push('recompute')
    }
  )
})

describe('public patch rating write transactions', () => {
  it('recomputes rating stats before the create transaction commits', async () => {
    findUniqueMock.mockResolvedValueOnce(null)

    await createPatchRating(createInput, kunTestActor({ uid: 7, role: 2 }))

    expect(recomputeOneMock).toHaveBeenCalledWith(10, transactionClient)
    expect(events).toEqual([
      'transaction-start',
      'recompute',
      'transaction-commit'
    ])
  })

  it('rolls back create when rating-stat recomputation fails', async () => {
    findUniqueMock.mockResolvedValueOnce(null)
    recomputeOneMock.mockRejectedValueOnce(new Error('rating stat failed'))

    await expect(
      createPatchRating(createInput, kunTestActor({ uid: 7, role: 2 }))
    ).rejects.toThrow('rating stat failed')
    expect(events).toEqual(['transaction-start', 'transaction-rollback'])
  })

  it('创建评价时把调用者角色透传给审核预筛', async () => {
    findUniqueMock.mockResolvedValueOnce(null)

    const actor = kunTestActor({ uid: 7, role: 3 })
    await createPatchRating(createInput, actor)

    expect(planTextModerationMock).toHaveBeenCalledWith(
      ratingSubject('summary'),
      { actor }
    )
    // 透传的就是调用方给的操作者 (同一对象)
    expect(planTextModerationMock.mock.calls[0][1].actor).toBe(actor)
  })

  it('并发重复评价撞唯一约束时返回业务错误而非抛出', async () => {
    findUniqueMock.mockResolvedValueOnce(null)
    createMock.mockRejectedValueOnce(prismaKnownError('P2002'))

    await expect(
      createPatchRating(createInput, kunTestActor({ uid: 7, role: 2 }))
    ).resolves.toBe('您已经评价过该游戏')
    expect(events).toEqual(['transaction-start', 'transaction-rollback'])
  })

  it('补丁外键失效时返回未找到 Galgame', async () => {
    findUniqueMock.mockResolvedValueOnce(null)
    createMock.mockRejectedValueOnce(prismaKnownError('P2003'))

    await expect(
      createPatchRating(createInput, kunTestActor({ uid: 7, role: 2 }))
    ).resolves.toBe('未找到 Galgame')
  })

  it('无关的 prisma 错误继续抛出', async () => {
    findUniqueMock.mockResolvedValueOnce(null)
    createMock.mockRejectedValueOnce(new Error('connection lost'))

    await expect(
      createPatchRating(createInput, kunTestActor({ uid: 7, role: 2 }))
    ).rejects.toThrow('connection lost')
  })
})
