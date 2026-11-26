import { beforeEach, describe, expect, it, vi } from 'vitest'

const { acquireKvLockMock, releaseKvLockMock } = vi.hoisted(() => ({
  acquireKvLockMock: vi.fn(),
  releaseKvLockMock: vi.fn()
}))

vi.mock('~/lib/redis', () => ({
  acquireKvLock: acquireKvLockMock,
  releaseKvLock: releaseKvLockMock
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'

const CACHE_KEY = 'test:key'
const LOCK_KEY = `${CACHE_KEY}:lock`
const CACHED = { value: 'cached' }
const QUERIED = { value: 'queried' }

const hit = { response: CACHED, canWrite: true }
const miss = { response: null, canWrite: true }
const readError = { response: null, canWrite: false }

describe('kunCacheSingleflight', () => {
  const readCache = vi.fn()
  const writeCache = vi.fn()
  const writeCacheIfAbsent = vi.fn()
  const query = vi.fn()

  const run = () =>
    kunCacheSingleflight({
      cacheKey: CACHE_KEY,
      readCache,
      writeCache,
      writeCacheIfAbsent,
      query
    })

  beforeEach(() => {
    vi.clearAllMocks()
    writeCache.mockResolvedValue(undefined)
    writeCacheIfAbsent.mockResolvedValue(undefined)
    releaseKvLockMock.mockResolvedValue(undefined)
    query.mockResolvedValue(QUERIED)
  })

  it('queries and writes cache when holding the lock on double-check miss', async () => {
    acquireKvLockMock.mockResolvedValue('token-1')
    readCache.mockResolvedValue(miss)

    await expect(run()).resolves.toEqual(QUERIED)

    expect(acquireKvLockMock).toHaveBeenCalledWith(LOCK_KEY, 10)
    expect(readCache).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
    expect(writeCache).toHaveBeenCalledWith(QUERIED)
    expect(releaseKvLockMock).toHaveBeenCalledWith(LOCK_KEY, 'token-1')
  })

  it('returns the double-checked cache without querying when holding the lock', async () => {
    acquireKvLockMock.mockResolvedValue('token-1')
    readCache.mockResolvedValue(hit)

    await expect(run()).resolves.toEqual(CACHED)

    expect(query).not.toHaveBeenCalled()
    expect(writeCache).not.toHaveBeenCalled()
    expect(releaseKvLockMock).toHaveBeenCalledWith(LOCK_KEY, 'token-1')
  })

  it('waits and returns the cache written by the lock holder', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    readCache.mockResolvedValueOnce(miss).mockResolvedValue(hit)

    await expect(run()).resolves.toEqual(CACHED)

    expect(readCache).toHaveBeenCalledTimes(2)
    expect(query).not.toHaveBeenCalled()
    expect(writeCacheIfAbsent).not.toHaveBeenCalled()
  })

  it('falls back to query and heals the cache when the wait times out', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    readCache.mockResolvedValue(miss)

    await expect(run()).resolves.toEqual(QUERIED)

    expect(readCache).toHaveBeenCalledTimes(3)
    expect(query).toHaveBeenCalledTimes(1)
    expect(writeCache).not.toHaveBeenCalled()
    expect(writeCacheIfAbsent).toHaveBeenCalledWith(QUERIED)
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('aborts the retry ladder and falls back on a cache read failure while waiting', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    readCache.mockResolvedValueOnce(miss).mockResolvedValue(readError)

    await expect(run()).resolves.toEqual(QUERIED)

    // 第二次读到 canWrite=false 即中止, 不消费第三级重试
    expect(readCache).toHaveBeenCalledTimes(2)
    expect(query).toHaveBeenCalledTimes(1)
    expect(writeCacheIfAbsent).toHaveBeenCalledWith(QUERIED)
  })

  it('falls back to query immediately when lock acquisition throws', async () => {
    acquireKvLockMock.mockRejectedValue(new Error('redis down'))

    await expect(run()).resolves.toEqual(QUERIED)

    expect(readCache).not.toHaveBeenCalled()
    expect(writeCache).not.toHaveBeenCalled()
    expect(writeCacheIfAbsent).not.toHaveBeenCalled()
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })
})
