import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: {
      findMany: findManyMock,
      count: countMock
    }
  }
}))

import { getGalgame } from '~/app/api/admin/galgame/service'
import { adminGalgamePaginationSchema } from '~/validations/admin'

describe('getGalgame 查询形状', () => {
  beforeEach(() => {
    findManyMock.mockReset().mockResolvedValue([])
    countMock.mockReset().mockResolvedValue(0)
  })

  it('只 select 映射用到的六个字段, 不再 include 拉取 patch 全部标量', async () => {
    const input = adminGalgamePaginationSchema.parse({ page: 1, limit: 30 })
    await getGalgame(input, {})

    const args = findManyMock.mock.calls[0][0]
    expect(args.include).toBeUndefined()
    expect(Object.keys(args.select).sort()).toEqual(
      ['banner', 'created', 'id', 'name', 'unique_id', 'user'].sort()
    )
    expect(args.select.user).toEqual({
      select: { id: true, name: true, avatar: true }
    })
  })

  it('有 search 时按名称不区分大小写过滤并合并 nsfw 条件, count 与 findMany 同 where', async () => {
    const input = adminGalgamePaginationSchema.parse({
      page: 2,
      limit: 50,
      search: 'kun'
    })
    await getGalgame(input, { content_limit: 'sfw' })

    const args = findManyMock.mock.calls[0][0]
    expect(args.where).toEqual({
      name: { contains: 'kun', mode: 'insensitive' },
      content_limit: 'sfw'
    })
    expect(args.skip).toBe(50)
    expect(args.take).toBe(50)
    expect(countMock.mock.calls[0][0].where).toEqual(args.where)
  })

  it('无 search 时 where 即 nsfw 条件本身', async () => {
    const input = adminGalgamePaginationSchema.parse({ page: 1, limit: 30 })
    const nsfwEnable = { content_limit: 'sfw' }
    await getGalgame(input, nsfwEnable)

    expect(findManyMock.mock.calls[0][0].where).toBe(nsfwEnable)
    expect(countMock.mock.calls[0][0].where).toBe(nsfwEnable)
  })

  it('把 unique_id 映射为 uniqueId 并透传 total', async () => {
    const created = new Date('2026-09-11T00:00:00Z')
    const user = { id: 7, name: 'moe', avatar: '' }
    findManyMock.mockResolvedValue([
      {
        id: 1,
        unique_id: 'abcdefgh',
        name: 'kun',
        banner: 'https://example.com/b.webp',
        created,
        user
      }
    ])
    countMock.mockResolvedValue(1)
    const input = adminGalgamePaginationSchema.parse({ page: 1, limit: 30 })

    const res = await getGalgame(input, {})

    expect(res).toEqual({
      galgames: [
        {
          id: 1,
          uniqueId: 'abcdefgh',
          name: 'kun',
          banner: 'https://example.com/b.webp',
          user,
          created
        }
      ],
      total: 1
    })
  })
})
