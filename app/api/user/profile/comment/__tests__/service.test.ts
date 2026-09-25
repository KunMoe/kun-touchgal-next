import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: {
      findMany: findManyMock,
      count: countMock
    }
  }
}))

import { getUserComment } from '~/app/api/user/profile/comment/service'

const input = { uid: 42, page: 1, limit: 10 }

const commentRow = (likes: number) => ({
  id: 1,
  content: '评论',
  user_id: 42,
  patch_id: 10,
  resource_id: null,
  created: new Date('2026-01-01T00:00:00.000Z'),
  patch: { unique_id: 'abcd1234', name: '游戏' },
  parent: null,
  _count: { like_by: likes }
})

beforeEach(() => {
  vi.resetAllMocks()
  findManyMock.mockResolvedValue([])
  countMock.mockResolvedValue(0)
})

// 关系 _count 会被 Prisma 编译成点赞表整表 GROUP BY (C15), 必须带 user_id 过滤才能走索引
describe('用户评论点赞计数限定在页面用户的评论内', () => {
  it('_count 带 comment.user_id 过滤', async () => {
    await getUserComment(input, { uid: 42, role: 1 })

    expect(findManyMock.mock.calls[0][0].select._count).toEqual({
      select: { like_by: { where: { comment: { user_id: 42 } } } }
    })
  })

  it('他人视角同样按页面用户过滤', async () => {
    await getUserComment(input, { uid: 9, role: 1 })

    expect(findManyMock.mock.calls[0][0].select._count).toEqual({
      select: { like_by: { where: { comment: { user_id: 42 } } } }
    })
  })

  it('计数映射到 like', async () => {
    findManyMock.mockResolvedValue([commentRow(5)])
    countMock.mockResolvedValue(1)

    const { comments } = await getUserComment(input, { uid: 9, role: 1 })

    expect(comments[0].like).toBe(5)
  })
})
