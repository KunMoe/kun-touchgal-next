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

import { getUserPatchRating } from '~/app/api/user/profile/rating/service'

const input = { uid: 42, page: 1, limit: 10 }

const ratingRow = (likes: number) => ({
  id: 1,
  patch: { unique_id: 'abcd1234', name: '游戏' },
  recommend: 'recommend',
  overall: 8,
  play_status: 'finished',
  short_summary: '',
  spoiler_level: 'none',
  created: new Date('2026-01-01T00:00:00.000Z'),
  _count: { like: likes }
})

beforeEach(() => {
  vi.resetAllMocks()
  findManyMock.mockResolvedValue([])
  countMock.mockResolvedValue(0)
})

// 关系 _count 会被 Prisma 编译成点赞表整表 GROUP BY (C15), 必须带 user_id 过滤才能走索引
describe('用户评价点赞计数限定在页面用户的评价内', () => {
  it('_count 带 patch_rating.user_id 过滤', async () => {
    await getUserPatchRating(input, { uid: 42, role: 1 })

    expect(findManyMock.mock.calls[0][0].include._count).toEqual({
      select: { like: { where: { patch_rating: { user_id: 42 } } } }
    })
  })

  it('他人视角同样按页面用户过滤', async () => {
    await getUserPatchRating(input, { uid: 9, role: 1 })

    expect(findManyMock.mock.calls[0][0].include._count).toEqual({
      select: { like: { where: { patch_rating: { user_id: 42 } } } }
    })
  })

  it('计数映射到 like', async () => {
    findManyMock.mockResolvedValue([ratingRow(5)])
    countMock.mockResolvedValue(1)

    const { ratings } = await getUserPatchRating(input, { uid: 9, role: 1 })

    expect(ratings[0].like).toBe(5)
  })
})
