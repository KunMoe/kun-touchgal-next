import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getKvMock,
  setKvMock,
  setKvIfAbsentMock,
  delKvMock,
  acquireKvLockMock,
  releaseKvLockMock,
  patchFindManyMock,
  resourceFindManyMock
} = vi.hoisted(() => ({
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  setKvIfAbsentMock: vi.fn(),
  delKvMock: vi.fn(),
  acquireKvLockMock: vi.fn(),
  releaseKvLockMock: vi.fn(),
  patchFindManyMock: vi.fn(),
  resourceFindManyMock: vi.fn()
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
    patch: { findMany: patchFindManyMock },
    patch_resource: { findMany: resourceFindManyMock }
  }
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { getHomeData } from '~/app/api/home/service'
import { toPublicListView } from '~/server/viewer/patchVisibility'

// 分级不限、无屏蔽标签的共享视角
const ALL_VIEW = toPublicListView({ contentLimit: null, blockedTagIds: [] })
// sha1('all:') 前 16 位
const CACHE_KEY = 'home:v2:69fdeab2a1c8368d'
const LOCK_KEY = `${CACHE_KEY}:lock`
const CACHED_RESPONSE = { galgames: [], resources: [{ id: 1 }] }

const blockedView = (count: number) =>
  toPublicListView({
    contentLimit: null,
    blockedTagIds: Array.from({ length: count }, (_, index) => index + 1)
  })

describe('getHomeData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    patchFindManyMock.mockResolvedValue([])
    resourceFindManyMock.mockResolvedValue([])
    setKvMock.mockResolvedValue(undefined)
    setKvIfAbsentMock.mockResolvedValue(true)
    releaseKvLockMock.mockResolvedValue(undefined)
  })

  it('returns cached response without querying or locking', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(CACHED_RESPONSE))

    const response = await getHomeData(ALL_VIEW)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).not.toHaveBeenCalled()
  })

  it('queries once and writes cache when the lock is acquired on miss', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')

    const response = await getHomeData(ALL_VIEW)

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(acquireKvLockMock).toHaveBeenCalledWith(LOCK_KEY, 10)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).toHaveBeenCalledWith(
      CACHE_KEY,
      JSON.stringify(response),
      60
    )
    expect(releaseKvLockMock).toHaveBeenCalledWith(LOCK_KEY, 'token-1')
  })

  // C15: 资源级 _count (like_by/links) 从未被渲染, 且 Prisma 7 会把它编译成
  // 点赞表/链接表整表 GROUP BY; 上传者的 _count.patch_resource 仍被渲染须保留
  it('does not select resource-level _count but keeps the uploader patch count', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')

    await getHomeData(ALL_VIEW)

    expect(resourceFindManyMock).toHaveBeenCalledTimes(1)
    const { select } = resourceFindManyMock.mock.calls[0][0]
    expect(select).not.toHaveProperty('_count')
    expect(select.user.select._count).toStrictEqual({
      select: { patch_resource: true }
    })
  })

  it('releases the lock when the query fails', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')
    patchFindManyMock.mockRejectedValue(new Error('db down'))

    await expect(getHomeData(ALL_VIEW)).rejects.toThrow('db down')

    expect(setKvMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).toHaveBeenCalledWith(LOCK_KEY, 'token-1')
  })

  it('waits and returns the cache written by the lock holder', async () => {
    getKvMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue(JSON.stringify(CACHED_RESPONSE))
    acquireKvLockMock.mockResolvedValue(null)

    const response = await getHomeData(ALL_VIEW)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('falls back to the database and heals the cache when the wait times out', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue(null)

    const response = await getHomeData(ALL_VIEW)

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(getKvMock).toHaveBeenCalledTimes(4)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).toHaveBeenCalledWith(
      CACHE_KEY,
      JSON.stringify(response),
      60
    )
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('falls back to the database immediately when lock acquisition fails', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockRejectedValue(new Error('redis down'))

    const response = await getHomeData(ALL_VIEW)

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(getKvMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('skips the shared cache entirely when any tag is blocked', async () => {
    const response = await getHomeData(blockedView(1))

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    // 屏蔽标签进查询条件, 资源仍按公开基线
    const blockedWhere = { NOT: { tag: { some: { tag_id: { in: [1] } } } } }
    expect(patchFindManyMock.mock.calls[0][0].where).toEqual(blockedWhere)
    expect(resourceFindManyMock.mock.calls[0][0].where).toEqual({
      patch: blockedWhere,
      section: 'patch',
      status: 0
    })
    expect(getKvMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('skips the shared cache for large blocked tag sets too', async () => {
    const response = await getHomeData(blockedView(60))

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('queries the personal view without the shared cache and with its own status filter', async () => {
    const response = await getHomeData({
      kind: 'personal',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] },
      viewer: { uid: 7, role: 1 }
    })

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(getKvMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
    expect(patchFindManyMock.mock.calls[0][0].where).toEqual({
      content_limit: 'sfw'
    })
    expect(resourceFindManyMock.mock.calls[0][0].where).toEqual({
      patch: { content_limit: 'sfw' },
      section: 'patch',
      OR: [{ status: 0 }, { status: { in: [2, 3] }, user_id: 7 }]
    })
  })

  it.each([
    ['sfw', 'home:v2:c01ede773657b5e2'],
    ['nsfw', 'home:v2:1f035bb8804256f0']
  ] as const)(
    'keys the %s shared view separately and queries the public baseline',
    async (contentLimit, cacheKey) => {
      getKvMock.mockResolvedValue(null)
      acquireKvLockMock.mockResolvedValue('token-1')

      await getHomeData(toPublicListView({ contentLimit, blockedTagIds: [] }))

      expect(getKvMock).toHaveBeenCalledWith(cacheKey)
      expect(resourceFindManyMock.mock.calls[0][0].where).toEqual({
        patch: { content_limit: contentLimit },
        section: 'patch',
        status: 0
      })
    }
  )

  it('queries directly without locking when the cache read fails', async () => {
    getKvMock.mockRejectedValue(new Error('redis down'))

    const response = await getHomeData(ALL_VIEW)

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })
})
