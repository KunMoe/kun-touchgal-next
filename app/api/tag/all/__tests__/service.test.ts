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
    patch_tag: {
      findMany: findManyMock,
      count: countMock
    }
  }
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { invalidateTagListCache } from '~/app/api/tag/cache'
import { getTag } from '~/app/api/tag/all/service'
import { PUBLIC_VISIBILITY } from '~/server/viewer/patchVisibility'

const TAGS = [{ id: 1, name: 'ADV', count: 7, alias: ['AVG'] }]
const RESPONSE = { tags: TAGS, total: 1 }

describe('getTag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findManyMock.mockResolvedValue(TAGS)
    countMock.mockResolvedValue(1)
    getKvMock.mockResolvedValue(null)
    setKvMock.mockResolvedValue(undefined)
    delKvMock.mockResolvedValue(undefined)
  })

  it('skips the shared cache but still applies blocked tags when any tag is blocked', async () => {
    const response = await getTag(
      { page: 1, limit: 100 },
      {
        contentLimit: 'sfw',
        blockedTagIds: [8, 9]
      }
    )

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { notIn: [8, 9] } } })
    )
    expect(getKvMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('queries the selected page and writes the response for 300 seconds on cache miss', async () => {
    const response = await getTag({ page: 2, limit: 100 }, PUBLIC_VISIBILITY)

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).toHaveBeenCalledWith({
      where: undefined,
      take: 100,
      skip: 100,
      orderBy: { count: 'desc' },
      select: {
        id: true,
        name: true,
        count: true,
        alias: true
      }
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

    const response = await getTag({ page: 1, limit: 100 }, PUBLIC_VISIBILITY)

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).not.toHaveBeenCalled()
    expect(countMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('isolates the cache key by page and limit', async () => {
    await getTag({ page: 1, limit: 100 }, PUBLIC_VISIBILITY)
    await getTag({ page: 2, limit: 100 }, PUBLIC_VISIBILITY)
    await getTag({ page: 1, limit: 50 }, PUBLIC_VISIBILITY)

    const cacheKeys = [1, 3, 5].map(
      (callIndex) => getKvMock.mock.calls[callIndex][0] as string
    )
    expect(new Set(cacheKeys).size).toBe(3)
  })

  it('queries directly and skips cache writes when the version read fails', async () => {
    getKvMock.mockRejectedValueOnce(new Error('redis down'))

    const response = await getTag({ page: 1, limit: 100 }, PUBLIC_VISIBILITY)

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('queries directly and skips cache writes when the list read fails', async () => {
    getKvMock
      .mockResolvedValueOnce('version-1')
      .mockRejectedValueOnce(new Error('redis down'))

    const response = await getTag({ page: 1, limit: 100 }, PUBLIC_VISIBILITY)

    expect(response).toEqual(RESPONSE)
    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('deletes an invalid payload and heals the cache from Prisma', async () => {
    getKvMock.mockResolvedValueOnce('version-1').mockResolvedValueOnce('{')

    const response = await getTag({ page: 1, limit: 100 }, PUBLIC_VISIBILITY)

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

    await expect(
      getTag({ page: 1, limit: 100 }, PUBLIC_VISIBILITY)
    ).resolves.toEqual(RESPONSE)
  })

  it('bumps the version and absorbs Redis invalidation failures', async () => {
    await invalidateTagListCache()

    expect(setKvMock).toHaveBeenCalledWith(
      'tag:list:version',
      expect.any(String)
    )

    setKvMock.mockRejectedValueOnce(new Error('redis down'))
    await expect(invalidateTagListCache()).resolves.toBeUndefined()
  })
})
