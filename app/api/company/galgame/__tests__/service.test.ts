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

vi.mock('~/prisma', () => ({
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

import { getPatchByCompany } from '~/app/api/company/galgame/service'
import { toPublicListView } from '~/server/viewer/patchVisibility'

const INPUT = {
  companyId: 5,
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

const getRequestedCacheKey = (callIndex = 0) =>
  getKvMock.mock.calls[callIndex][0] as string

describe('getPatchByCompany', () => {
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

  it('returns cached response without querying or locking', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(CACHED_RESPONSE))

    const response = await getPatchByCompany(INPUT, VIEW)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(getRequestedCacheKey()).toMatch(/^galgame:list:company:5:/)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(queryGalgameIndexMock).not.toHaveBeenCalled()
  })

  it('queries meilisearch once and writes cache when the lock is acquired on miss', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getPatchByCompany(INPUT, VIEW)

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
  })

  it('falls back to prisma and still writes cache when meilisearch fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    queryGalgameIndexMock.mockRejectedValue(new Error('meili down'))

    const response = await getPatchByCompany(INPUT, VIEW)

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchCountMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).toHaveBeenCalledWith(
      getRequestedCacheKey(),
      JSON.stringify(response),
      60
    )
  })

  it('uses a different cache key per company and ignores minRatingCount for non-rating sorts', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(CACHED_RESPONSE))

    await getPatchByCompany(INPUT, VIEW)
    await getPatchByCompany({ ...INPUT, companyId: 6 }, VIEW)
    await getPatchByCompany({ ...INPUT, minRatingCount: 10 }, VIEW)

    expect(getRequestedCacheKey(1)).toMatch(/^galgame:list:company:6:/)
    expect(getRequestedCacheKey(1)).not.toBe(getRequestedCacheKey(0))
    expect(getRequestedCacheKey(2)).toBe(getRequestedCacheKey(0))
  })
})
