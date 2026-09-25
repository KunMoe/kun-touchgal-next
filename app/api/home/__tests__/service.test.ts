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

import { getHomeData } from '~/app/api/home/service'

// sha1('all:') 前 16 位, 即 buildVisibilityCacheKey({}) 的哈希
const CACHE_KEY = 'home:v2:69fdeab2a1c8368d'
const LOCK_KEY = `${CACHE_KEY}:lock`
const CACHED_RESPONSE = { galgames: [], resources: [{ id: 1 }] }

const blockedTagWhere = (count: number) => ({
  NOT: {
    tag: {
      some: {
        tag_id: { in: Array.from({ length: count }, (_, index) => index + 1) }
      }
    }
  }
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

    const response = await getHomeData({}, null, false)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).not.toHaveBeenCalled()
  })

  it('queries once and writes cache when the lock is acquired on miss', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue('token-1')

    const response = await getHomeData({}, null, false)

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

    await getHomeData({}, null, false)

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

    await expect(getHomeData({}, null, false)).rejects.toThrow('db down')

    expect(setKvMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).toHaveBeenCalledWith(LOCK_KEY, 'token-1')
  })

  it('waits and returns the cache written by the lock holder', async () => {
    getKvMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue(JSON.stringify(CACHED_RESPONSE))
    acquireKvLockMock.mockResolvedValue(null)

    const response = await getHomeData({}, null, false)

    expect(response).toEqual(CACHED_RESPONSE)
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('falls back to the database and heals the cache when the wait times out', async () => {
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockResolvedValue(null)

    const response = await getHomeData({}, null, false)

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
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getKvMock.mockResolvedValue(null)
    acquireKvLockMock.mockRejectedValue(new Error('redis down'))

    const response = await getHomeData({}, null, false)

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(getKvMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('skips the shared cache entirely when any tag is blocked', async () => {
    const response = await getHomeData(blockedTagWhere(1), null, false)

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('skips the shared cache for large blocked tag sets too', async () => {
    const response = await getHomeData(blockedTagWhere(60), null, false)

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('queries directly without locking when the cache read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getKvMock.mockRejectedValue(new Error('redis down'))

    const response = await getHomeData({}, null, false)

    expect(response).toEqual({ galgames: [], resources: [] })
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })
})
