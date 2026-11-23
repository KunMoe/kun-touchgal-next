import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { acquireKvLockMock, releaseKvLockMock, renewKvLockMock } = vi.hoisted(
  () => ({
    acquireKvLockMock: vi.fn(),
    releaseKvLockMock: vi.fn(),
    renewKvLockMock: vi.fn()
  })
)

vi.mock('~/lib/redis', () => ({
  acquireKvLock: acquireKvLockMock,
  releaseKvLock: releaseKvLockMock,
  renewKvLock: renewKvLockMock
}))

import { withTaskLock } from '~/server/tasks/withTaskLock'

const options = { key: 'k', ttlSeconds: 60, taskName: 't' }

beforeEach(() => {
  vi.useFakeTimers()
  acquireKvLockMock.mockReset()
  releaseKvLockMock.mockReset().mockResolvedValue(undefined)
  renewKvLockMock.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('withTaskLock', () => {
  it('默认不等: 锁被占着时立即返回 undefined, 不执行任务', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    const task = vi.fn()

    expect(await withTaskLock(options, task)).toBeUndefined()
    expect(acquireKvLockMock).toHaveBeenCalledTimes(1)
    expect(task).not.toHaveBeenCalled()
  })

  it('给了 waitMs: 每 2 秒再试一次, 等到锁就执行并释放', async () => {
    acquireKvLockMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('token')

    const running = withTaskLock({ ...options, waitMs: 10_000 }, async () => 1)
    await vi.advanceTimersByTimeAsync(4_000)

    expect(await running).toBe(1)
    expect(acquireKvLockMock).toHaveBeenCalledTimes(3)
    expect(releaseKvLockMock).toHaveBeenCalledWith('k', 'token')
  })

  it('等过了 waitMs 仍拿不到就返回 undefined', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    const task = vi.fn()

    const running = withTaskLock({ ...options, waitMs: 5_000 }, task)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await running).toBeUndefined()
    expect(task).not.toHaveBeenCalled()
    // 0、2、4、6 秒各试一次: 第 6 秒那次已过时限, 拿不到就返回
    expect(acquireKvLockMock).toHaveBeenCalledTimes(4)
  })

  it('Redis 出错仍只重试 3 次, 锁被占着的等待不占用这 3 次', async () => {
    acquireKvLockMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))

    const running = withTaskLock({ ...options, waitMs: 60_000 }, vi.fn())
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await running).toBeUndefined()
    expect(acquireKvLockMock).toHaveBeenCalledTimes(4)
  })
})
