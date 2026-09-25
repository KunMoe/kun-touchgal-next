import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_rating: {
      findMany: findManyMock,
      count: countMock
    }
  }
}))

import { getPatchRating } from '~/app/api/patch/rating/get'

const input = { patchId: 10, page: 1, limit: 10, onlyWithShortSummary: false }

const ratingRow = (likes: number) => ({
  id: 1,
  patch: { unique_id: 'abcd1234' },
  recommend: 'recommend',
  overall: 8,
  play_status: 'finished',
  short_summary: '',
  spoiler_level: 'none',
  status: 0,
  like: [],
  _count: { like: likes },
  user_id: 3,
  patch_id: 10,
  created: new Date('2026-01-01T00:00:00.000Z'),
  updated: new Date('2026-01-01T00:00:00.000Z'),
  user: { id: 3, name: '用户3', avatar: '' }
})

beforeEach(() => {
  vi.resetAllMocks()
  findManyMock.mockResolvedValue([])
  countMock.mockResolvedValue(0)
})

// 关系 _count 会被 Prisma 编译成点赞表整表 GROUP BY (C15), 必须带 patch_id 过滤才能走索引
describe('评价点赞计数限定在本 patch 内', () => {
  it('_count 带 patch_rating.patch_id 过滤', async () => {
    await getPatchRating(input, { uid: 7, role: 1 })

    expect(findManyMock.mock.calls[0][0].include._count).toEqual({
      select: { like: { where: { patch_rating: { patch_id: 10 } } } }
    })
  })

  it('游客视角同样按 patch_id 过滤', async () => {
    await getPatchRating(input, { uid: 0, role: 0 })

    expect(findManyMock.mock.calls[0][0].include._count).toEqual({
      select: { like: { where: { patch_rating: { patch_id: 10 } } } }
    })
  })

  it('计数映射到 likeCount', async () => {
    findManyMock.mockResolvedValue([ratingRow(5)])
    countMock.mockResolvedValue(1)

    const { ratings } = await getPatchRating(input, { uid: 7, role: 1 })

    expect(ratings[0].likeCount).toBe(5)
  })
})
