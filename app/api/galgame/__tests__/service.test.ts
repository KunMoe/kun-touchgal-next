import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getKvMock,
  setKvMock,
  setKvIfAbsentMock,
  delKvMock,
  acquireKvLockMock,
  releaseKvLockMock,
  patchFindManyMock,
  patchCountMock,
  isMeiliEnabledMock,
  queryGalgameIndexMock
} = vi.hoisted(() => ({
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  setKvIfAbsentMock: vi.fn(),
  delKvMock: vi.fn(),
  acquireKvLockMock: vi.fn(),
  releaseKvLockMock: vi.fn(),
  patchFindManyMock: vi.fn(),
  patchCountMock: vi.fn(),
  isMeiliEnabledMock: vi.fn(),
  queryGalgameIndexMock: vi.fn()
}))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock,
  setKvIfAbsent: setKvIfAbsentMock,
  delKv: delKvMock,
  acquireKvLock: acquireKvLockMock,
  releaseKvLock: releaseKvLockMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findMany: patchFindManyMock, count: patchCountMock }
  }
}))

vi.mock('~/lib/meilisearch', () => ({
  isMeiliEnabled: isMeiliEnabledMock
}))

vi.mock('~/server/search/query', () => ({
  queryGalgameIndex: queryGalgameIndexMock
}))

vi.mock('~/server/search/filter-builder', () => ({
  buildGalgameSearchFilter: vi.fn().mockReturnValue('filter-expr'),
  buildGalgameSearchSort: vi.fn().mockReturnValue([])
}))

import { getGalgame } from '~/app/api/galgame/service'
import { toPublicListView } from '~/server/viewer/patchVisibility'

const blockedView = (count: number) =>
  toPublicListView({
    contentLimit: null,
    blockedTagIds: Array.from({ length: count }, (_, index) => index + 1)
  })

const INPUT = {
  selectedType: 'all',
  selectedLanguage: 'all',
  selectedPlatform: 'all',
  sortField: 'created',
  sortOrder: 'desc',
  page: 1,
  limit: 24,
  yearString: '["all"]',
  monthString: '["all"]',
  minRatingCount: 0
} as const

// 分级不限、无屏蔽标签的共享视角
const VIEW = toPublicListView({ contentLimit: null, blockedTagIds: [] })

const EMPTY_RESPONSE = { galgames: [], total: 0 }
const CACHED_RESPONSE = { galgames: [], total: 3 }

const getRequestedCacheKey = () => getKvMock.mock.calls[0][0] as string

describe('getGalgame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    patchFindManyMock.mockResolvedValue([])
    patchCountMock.mockResolvedValue(0)
    setKvMock.mockResolvedValue(undefined)
    setKvIfAbsentMock.mockResolvedValue(true)
    releaseKvLockMock.mockResolvedValue(undefined)
    isMeiliEnabledMock.mockReturnValue(false)
    queryGalgameIndexMock.mockResolvedValue(EMPTY_RESPONSE)
  })

  it('skips the shared cache entirely when any tag is blocked', async () => {
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getGalgame(INPUT, blockedView(1))

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(queryGalgameIndexMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('skips the shared cache for large blocked tag sets too', async () => {
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getGalgame(INPUT, blockedView(60))

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(queryGalgameIndexMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('returns cached response without querying or locking', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(CACHED_RESPONSE))

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(queryGalgameIndexMock).not.toHaveBeenCalled()
  })

  it('queries meilisearch once and writes cache when the lock is acquired on miss', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getGalgame(INPUT, VIEW)

    const cacheKey = getRequestedCacheKey()
    expect(response).toEqual(EMPTY_RESPONSE)
    expect(acquireKvLockMock).toHaveBeenCalledWith(`${cacheKey}:lock`, 10)
    expect(queryGalgameIndexMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(setKvMock).toHaveBeenCalledWith(
      cacheKey,
      JSON.stringify(response),
      60
    )
    expect(releaseKvLockMock).toHaveBeenCalledWith(
      `${cacheKey}:lock`,
      'token-1'
    )
  })

  it('falls back to prisma and still writes cache when meilisearch fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    queryGalgameIndexMock.mockRejectedValue(new Error('meili down'))

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchCountMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).toHaveBeenCalledWith(
      getRequestedCacheKey(),
      JSON.stringify(response),
      60
    )
  })

  it('waits and returns the cache written by the lock holder', async () => {
    getKvMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue(JSON.stringify(CACHED_RESPONSE))
    acquireKvLockMock.mockResolvedValue(null)

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('falls back to the database and heals the cache when the wait times out', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue(null)

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(getKvMock).toHaveBeenCalledTimes(4)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).toHaveBeenCalledWith(
      getRequestedCacheKey(),
      JSON.stringify(response),
      60
    )
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('queries directly without locking when the cache read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getKvMock.mockRejectedValue(new Error('redis down'))

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
  })
})
