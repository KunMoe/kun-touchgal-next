import { beforeEach, describe, expect, it, vi } from 'vitest'

// 按 id 搜索时, 超出 int4 的数字原样发给库会被以 22003 拒绝 (P2020), 冒泡成 500;
// 这样的 id 不可能对应任何用户, 与非数字的输入一样查不到人

const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findMany: findManyMock, count: countMock }
  }
}))

import { getUserInfo } from '~/app/api/admin/user/get'

const searchById = (search: string) =>
  getUserInfo({ page: 1, limit: 30, search, searchType: 'id' })

beforeEach(() => {
  vi.resetAllMocks()
  findManyMock.mockResolvedValue([])
  countMock.mockResolvedValue(0)
})

describe('getUserInfo 按 id 搜索', () => {
  it.each([
    ['5', 5],
    [' 42 ', 42],
    ['2147483647', 2147483647]
  ])('int4 以内的 %j 按原值查', async (search, id) => {
    await searchById(search)

    expect(findManyMock.mock.calls[0][0].where).toEqual({ id })
    expect(countMock.mock.calls[0][0].where).toEqual({ id })
  })

  it.each(['2147483648', '3000000000', '99999999999999999999', 'abc', '1.5'])(
    '%j 查不到任何人, 不把越界的值交给库',
    async (search) => {
      await searchById(search)

      expect(findManyMock.mock.calls[0][0].where).toEqual({ id: 0 })
      expect(countMock.mock.calls[0][0].where).toEqual({ id: 0 })
    }
  )
})
