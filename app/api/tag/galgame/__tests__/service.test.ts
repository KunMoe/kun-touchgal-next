import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getKvMock,
  setKvMock,
  setKvIfAbsentMock,
  delKvMock,
  acquireKvLockMock,
  releaseKvLockMock,
  relationFindManyMock,
  relationCountMock,
  isMeiliEnabledMock,
  queryGalgameIndexMock
} = vi.hoisted(() => ({
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  setKvIfAbsentMock: vi.fn(),
  delKvMock: vi.fn(),
  acquireKvLockMock: vi.fn(),
  releaseKvLockMock: vi.fn(),
  relationFindManyMock: vi.fn(),
  relationCountMock: vi.fn(),
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
    patch_tag_relation: {
      findMany: relationFindManyMock,
      count: relationCountMock
    }
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

import { getPatchByTag } from '~/app/api/tag/galgame/service'
import { toPublicListView } from '~/server/viewer/patchVisibility'

const INPUT = {
  tagId: 17,
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

describe('getPatchByTag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    relationFindManyMock.mockResolvedValue([])
    relationCountMock.mockResolvedValue(0)
    setKvMock.mockResolvedValue(undefined)
    setKvIfAbsentMock.mockResolvedValue(true)
    releaseKvLockMock.mockResolvedValue(undefined)
    isMeiliEnabledMock.mockReturnValue(false)
    queryGalgameIndexMock.mockResolvedValue(EMPTY_RESPONSE)
  })

  it('returns cached response without querying or locking', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(CACHED_RESPONSE))

    const response = await getPatchByTag(INPUT, VIEW)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(getRequestedCacheKey()).toMatch(/^galgame:list:tag:17:/)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(queryGalgameIndexMock).not.toHaveBeenCalled()
  })

  it('queries meilisearch once and writes cache when the lock is acquired on miss', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getPatchByTag(INPUT, VIEW)

    const cacheKey = getRequestedCacheKey()
    expect(response).toEqual(EMPTY_RESPONSE)
    expect(acquireKvLockMock).toHaveBeenCalledWith(`${cacheKey}:lock`, 10)
    expect(queryGalgameIndexMock).toHaveBeenCalledTimes(1)
    expect(relationFindManyMock).not.toHaveBeenCalled()
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

    const response = await getPatchByTag(INPUT, VIEW)

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(relationFindManyMock).toHaveBeenCalledTimes(1)
    expect(relationCountMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).toHaveBeenCalledWith(
      getRequestedCacheKey(),
      JSON.stringify(response),
      60
    )
  })

  it('uses a different cache key per tag and ignores minRatingCount for non-rating sorts', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(CACHED_RESPONSE))

    await getPatchByTag(INPUT, VIEW)
    await getPatchByTag({ ...INPUT, tagId: 18 }, VIEW)
    await getPatchByTag({ ...INPUT, minRatingCount: 10 }, VIEW)

    expect(getRequestedCacheKey(1)).toMatch(/^galgame:list:tag:18:/)
    expect(getRequestedCacheKey(1)).not.toBe(getRequestedCacheKey(0))
    expect(getRequestedCacheKey(2)).toBe(getRequestedCacheKey(0))
  })
})
