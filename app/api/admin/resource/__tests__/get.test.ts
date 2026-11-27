import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_resource: {
      findMany: findManyMock,
      count: countMock
    }
  }
}))

import { getPatchResource } from '~/app/api/admin/resource/get'
import { adminResourcePaginationSchema } from '~/validations/admin'

describe('getPatchResource 搜索过滤', () => {
  beforeEach(() => {
    findManyMock.mockReset().mockResolvedValue([])
    countMock.mockReset().mockResolvedValue(0)
  })

  it('searchType=info 时按资源名称与备注过滤', async () => {
    const input = adminResourcePaginationSchema.parse({
      page: 1,
      limit: 30,
      search: 'kun',
      searchType: 'info'
    })
    await getPatchResource(input, null)

    const { where } = findManyMock.mock.calls[0][0]
    expect(where.OR).toEqual([
      { name: { contains: 'kun', mode: 'insensitive' } },
      { note: { contains: 'kun', mode: 'insensitive' } }
    ])
    expect(where.links).toBeUndefined()
    expect(countMock.mock.calls[0][0].where).toEqual(where)
  })

  it('未传 searchType 时默认按链接与 hash 过滤', async () => {
    const input = adminResourcePaginationSchema.parse({
      page: 1,
      limit: 30,
      search: 'magnet:'
    })
    expect(input.searchType).toBe('content')
    await getPatchResource(input, null)

    const { where } = findManyMock.mock.calls[0][0]
    expect(where.links.some.OR).toEqual([
      { content: { contains: 'magnet:', mode: 'insensitive' } },
      { hash: { contains: 'magnet:', mode: 'insensitive' } }
    ])
    expect(where.OR).toBeUndefined()
  })

  it('无 search 时不附加搜索过滤', async () => {
    const input = adminResourcePaginationSchema.parse({
      page: 1,
      limit: 30,
      searchType: 'info'
    })
    await getPatchResource(input, null)

    const { where } = findManyMock.mock.calls[0][0]
    expect(where.OR).toBeUndefined()
    expect(where.links).toBeUndefined()
    expect(where.id).toBeUndefined()
  })

  it('带 resourceId 时按资源 ID 精确匹配', async () => {
    const input = adminResourcePaginationSchema.parse({
      page: 1,
      limit: 30,
      resourceId: '233'
    })
    await getPatchResource(input, null)

    const { where } = findManyMock.mock.calls[0][0]
    expect(where.id).toBe(233)
    expect(where.OR).toBeUndefined()
    expect(where.links).toBeUndefined()
    expect(countMock.mock.calls[0][0].where).toEqual(where)
  })

  it.each(['abc', '1.5', '0', '2147483648'])(
    'resourceId 为 %s 时在校验阶段被拒',
    (resourceId) => {
      const result = adminResourcePaginationSchema.safeParse({
        page: 1,
        limit: 30,
        resourceId
      })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.message).toBe('资源 ID 无效')
    }
  )
})
