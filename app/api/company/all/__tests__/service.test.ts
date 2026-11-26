import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, countMock, getKvMock, setKvMock, delKvMock } = vi.hoisted(
  () => ({
    findManyMock: vi.fn(),
    countMock: vi.fn(),
    getKvMock: vi.fn(),
    setKvMock: vi.fn(),
    delKvMock: vi.fn()
  })
)

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock,
  delKv: delKvMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_company: {
      findMany: findManyMock,
      count: countMock
    }
  }
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { invalidateCompanyListCache } from '~/app/api/company/cache'
import { getCompany } from '~/app/api/company/all/service'

const COMPANIES = [{ id: 1, name: 'Key', count: 7, alias: ['VisualArt’s/Key'] }]
const RESPONSE = { companies: COMPANIES, total: 1 }

describe('getCompany', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findManyMock.mockResolvedValue(COMPANIES)
    countMock.mockResolvedValue(1)
    getKvMock.mockResolvedValue(null)
    setKvMock.mockResolvedValue(undefined)
    delKvMock.mockResolvedValue(undefined)
  })

  it('queries the selected page and writes the response for 300 seconds on cache miss', async () => {
    const response = await getCompany({ page: 2, limit: 100 })

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).toHaveBeenCalledWith({
      take: 100,
      skip: 100,
      select: {
        id: true,
        name: true,
        count: true,
        alias: true
      },
      orderBy: { count: 'desc' }
    })
    const cacheKey = getKvMock.mock.calls[1][0] as string
    expect(setKvMock).toHaveBeenCalledWith(
      cacheKey,
      JSON.stringify(RESPONSE),
      300
    )
  })

  it('returns a cached response without querying Prisma', async () => {
    getKvMock
      .mockResolvedValueOnce('version-1')
      .mockResolvedValueOnce(JSON.stringify(RESPONSE))

    const response = await getCompany({ page: 1, limit: 100 })

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).not.toHaveBeenCalled()
    expect(countMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('isolates pages and limits in cache keys', async () => {
    await getCompany({ page: 1, limit: 100 })
    await getCompany({ page: 2, limit: 100 })
    await getCompany({ page: 1, limit: 50 })

    const cacheKeys = [1, 3, 5].map(
      (callIndex) => getKvMock.mock.calls[callIndex][0] as string
    )
    expect(new Set(cacheKeys).size).toBe(3)
  })

  it('queries directly and skips cache writes when the version read fails', async () => {
    getKvMock.mockRejectedValueOnce(new Error('redis down'))

    const response = await getCompany({ page: 1, limit: 100 })

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('queries directly and skips cache writes when the list read fails', async () => {
    getKvMock
      .mockResolvedValueOnce('version-1')
      .mockRejectedValueOnce(new Error('redis down'))

    const response = await getCompany({ page: 1, limit: 100 })

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('deletes an invalid payload and heals the cache from Prisma', async () => {
    getKvMock.mockResolvedValueOnce('version-1').mockResolvedValueOnce('{')

    const response = await getCompany({ page: 1, limit: 100 })

    const cacheKey = getKvMock.mock.calls[1][0] as string
    expect(response).toEqual(RESPONSE)
    expect(delKvMock).toHaveBeenCalledWith(cacheKey)
    expect(setKvMock).toHaveBeenCalledWith(
      cacheKey,
      JSON.stringify(RESPONSE),
      300
    )
  })

  it('returns the database response when the cache write fails', async () => {
    setKvMock.mockRejectedValueOnce(new Error('redis down'))

    await expect(getCompany({ page: 1, limit: 100 })).resolves.toEqual(RESPONSE)
  })

  it('bumps the version and absorbs Redis invalidation failures', async () => {
    await invalidateCompanyListCache()

    expect(setKvMock).toHaveBeenCalledWith(
      'company:list:version',
      expect.any(String)
    )

    setKvMock.mockRejectedValueOnce(new Error('redis down'))
    await expect(invalidateCompanyListCache()).resolves.toBeUndefined()
  })
})
