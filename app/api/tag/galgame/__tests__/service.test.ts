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
  patchFindManyMock,
  isMeiliEnabledMock,
  queryGalgameIdsMock
} = vi.hoisted(() => ({
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  setKvIfAbsentMock: vi.fn(),
  delKvMock: vi.fn(),
  acquireKvLockMock: vi.fn(),
  releaseKvLockMock: vi.fn(),
  relationFindManyMock: vi.fn(),
  relationCountMock: vi.fn(),
  patchFindManyMock: vi.fn(),
  isMeiliEnabledMock: vi.fn(),
  queryGalgameIdsMock: vi.fn()
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
    },
    patch: { findMany: patchFindManyMock }
  }
}))

vi.mock('~/lib/meilisearch', () => ({
  isMeiliEnabled: isMeiliEnabledMock
}))

vi.mock('~/server/search/query', () => ({
  queryGalgameIds: queryGalgameIdsMock
}))

vi.mock('~/server/search/filter-builder', () => ({
  buildGalgameSearchFilter: vi.fn().mockReturnValue('filter-expr'),
  buildGalgameSearchSort: vi.fn().mockReturnValue([])
}))

import { getPatchByTag } from '~/app/api/tag/galgame/service'
import { toPublicListView } from '~/server/viewer/patchVisibility'
import { GalgameCardSelectField } from '~/constants/api/select'
import { buildGalgameSearchSort } from '~/server/search/filter-builder'
import { meiliApiError, meiliDown } from '~/server/search/__tests__/meiliErrors'
import { cardRow } from '~/server/galgame/__tests__/cardRow'

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
const SFW_VIEW = toPublicListView({ contentLimit: 'sfw', blockedTagIds: [] })

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
    queryGalgameIdsMock.mockResolvedValue({ ids: [], total: 0 })
  })

  it('returns cached response without querying or locking', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(CACHED_RESPONSE))

    const response = await getPatchByTag(INPUT, VIEW)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(getRequestedCacheKey()).toMatch(/^galgame:list:tag:17:/)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(queryGalgameIdsMock).not.toHaveBeenCalled()
  })

  it('queries meilisearch once and writes cache when the lock is acquired on miss', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getPatchByTag(INPUT, VIEW)

    const cacheKey = getRequestedCacheKey()
    expect(response).toEqual(EMPTY_RESPONSE)
    expect(acquireKvLockMock).toHaveBeenCalledWith(`${cacheKey}:lock`, 10)
    expect(queryGalgameIdsMock).toHaveBeenCalledTimes(1)
    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(setKvMock).toHaveBeenCalledWith(
      cacheKey,
      JSON.stringify(response),
      60
    )
  })

  it('falls back to prisma and still writes cache when meilisearch is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    queryGalgameIdsMock.mockRejectedValue(meiliDown())
    relationFindManyMock.mockResolvedValue([{ patch: cardRow(3) }])
    relationCountMock.mockResolvedValue(1)

    const response = await getPatchByTag(INPUT, VIEW)

    expect(response).toMatchObject({ galgames: [{ id: 3 }], total: 1 })
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

  it('passes page, page size and sort through to the index query', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    vi.mocked(buildGalgameSearchSort).mockReturnValueOnce(['sort-expr'])

    await getPatchByTag(
      { ...INPUT, page: 3, limit: 12, sortField: 'view', sortOrder: 'asc' },
      VIEW
    )

    expect(buildGalgameSearchSort).toHaveBeenCalledWith('view', 'asc')
    expect(queryGalgameIdsMock).toHaveBeenCalledWith({
      q: '',
      filter: 'filter-expr',
      sort: ['sort-expr'],
      page: 3,
      hitsPerPage: 12
    })
  })

  it('hydrates index hits from PG under the viewer visibility and caches the hydrated cards', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    queryGalgameIdsMock.mockResolvedValue({ ids: [2, 1], total: 30 })
    patchFindManyMock.mockResolvedValue([cardRow(1), cardRow(2)])

    const response = await getPatchByTag(INPUT, SFW_VIEW)

    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock).toHaveBeenCalledWith({
      where: { AND: [{ id: { in: [2, 1] } }, { content_limit: 'sfw' }] },
      select: GalgameCardSelectField
    })
    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(relationCountMock).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      galgames: [{ id: 2 }, { id: 1 }],
      total: 30
    })
    expect(setKvMock).toHaveBeenCalledWith(
      getRequestedCacheKey(),
      JSON.stringify(response),
      60
    )
  })

  it('does not fall back to prisma when the failure is not a meilisearch error', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    const bug = new TypeError('boom')
    queryGalgameIdsMock.mockRejectedValue(bug)

    await expect(getPatchByTag(INPUT, VIEW)).rejects.toBe(bug)
    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(relationCountMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('does not fall back to prisma when hydrating from PG fails', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    const pgDown = new Error('pg down')
    queryGalgameIdsMock.mockResolvedValue({ ids: [1], total: 1 })
    patchFindManyMock.mockRejectedValue(pgDown)

    await expect(getPatchByTag(INPUT, VIEW)).rejects.toBe(pgDown)
    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(relationCountMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('answers a business error and caches nothing when meilisearch rejects the request parameters', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    queryGalgameIdsMock.mockRejectedValue(
      meiliApiError(400, 'malformed_payload')
    )

    const response = await getPatchByTag(INPUT, VIEW)

    expect(response).toBe('筛选条件格式错误')
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(relationCountMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).toHaveBeenCalledTimes(1)
  })
})
