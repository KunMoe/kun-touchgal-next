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
  queryGalgameIdsMock
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
    patch: { findMany: patchFindManyMock, count: patchCountMock }
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

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { getGalgame } from '~/app/api/galgame/service'
import { toPublicListView } from '~/server/viewer/patchVisibility'
import { GalgameCardSelectField } from '~/constants/api/select'
import { buildGalgameSearchSort } from '~/server/search/filter-builder'
import { meiliApiError, meiliDown } from '~/server/search/__tests__/meiliErrors'
import { cardRow } from '~/server/galgame/__tests__/cardRow'

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
const SFW_VIEW = toPublicListView({ contentLimit: 'sfw', blockedTagIds: [] })

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
    queryGalgameIdsMock.mockResolvedValue({ ids: [], total: 0 })
  })

  it('skips the shared cache entirely when any tag is blocked', async () => {
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getGalgame(INPUT, blockedView(1))

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(queryGalgameIdsMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('skips the shared cache for large blocked tag sets too', async () => {
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getGalgame(INPUT, blockedView(60))

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(queryGalgameIdsMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('returns cached response without querying or locking', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(CACHED_RESPONSE))

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(queryGalgameIdsMock).not.toHaveBeenCalled()
  })

  it('queries meilisearch once and writes cache when the lock is acquired on miss', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)

    const response = await getGalgame(INPUT, VIEW)

    const cacheKey = getRequestedCacheKey()
    expect(response).toEqual(EMPTY_RESPONSE)
    expect(acquireKvLockMock).toHaveBeenCalledWith(`${cacheKey}:lock`, 10)
    expect(queryGalgameIdsMock).toHaveBeenCalledTimes(1)
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

  it('falls back to prisma and still writes cache when meilisearch is unavailable', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    queryGalgameIdsMock.mockRejectedValue(meiliDown())
    patchFindManyMock.mockResolvedValue([cardRow(3)])
    patchCountMock.mockResolvedValue(1)

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toMatchObject({ galgames: [{ id: 3 }], total: 1 })
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
    getKvMock.mockRejectedValue(new Error('redis down'))

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toEqual(EMPTY_RESPONSE)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('passes page, page size and sort through to the index query', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    vi.mocked(buildGalgameSearchSort).mockReturnValueOnce(['sort-expr'])

    await getGalgame(
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

    const response = await getGalgame(INPUT, SFW_VIEW)

    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock).toHaveBeenCalledWith({
      where: { AND: [{ id: { in: [2, 1] } }, { content_limit: 'sfw' }] },
      select: GalgameCardSelectField
    })
    expect(patchCountMock).not.toHaveBeenCalled()
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

    await expect(getGalgame(INPUT, VIEW)).rejects.toBe(bug)
    expect(patchCountMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('does not fall back to prisma when hydrating from PG fails', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    const pgDown = new Error('pg down')
    queryGalgameIdsMock.mockResolvedValue({ ids: [1], total: 1 })
    patchFindManyMock.mockRejectedValue(pgDown)

    await expect(getGalgame(INPUT, VIEW)).rejects.toBe(pgDown)
    expect(patchCountMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('answers a business error and caches nothing when meilisearch rejects the request parameters', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    isMeiliEnabledMock.mockReturnValue(true)
    queryGalgameIdsMock.mockRejectedValue(
      meiliApiError(400, 'malformed_payload')
    )

    const response = await getGalgame(INPUT, VIEW)

    expect(response).toBe('筛选条件格式错误')
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(patchCountMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).toHaveBeenCalledTimes(1)
  })
})
