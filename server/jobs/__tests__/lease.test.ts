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
vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  DEFAULT_LEASE_STALL_MS,
  DEFAULT_LEASE_TTL_SECONDS,
  LeaseLostError,
  claimJobSlot,
  withJobLease
} from '~/server/jobs/lease'
import type { JobLease } from '~/server/jobs/lease'

const spec = { name: 'drain', key: 'k' }
const HEARTBEAT_MS = (DEFAULT_LEASE_TTL_SECONDS * 1000) / 3

beforeEach(() => {
  vi.useFakeTimers()
  acquireKvLockMock.mockReset().mockResolvedValue('token')
  releaseKvLockMock.mockReset().mockResolvedValue(undefined)
  renewKvLockMock.mockReset().mockResolvedValue(true)
  vi.mocked(kunLog).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// 持着租约停在半路, 由用例决定何时结束
const holdLease = () => {
  let lease: JobLease | undefined
  const { promise, resolve } = Promise.withResolvers<string>()
  const running = withJobLease(spec, async (held) => {
    lease = held
    return promise
  })
  return {
    running,
    lease: () => lease!,
    finish: () => resolve('done')
  }
}

describe('抢锁', () => {
  it('默认 TTL 60 秒, 抢到就执行, 结束后按自己的 token 释放', async () => {
    await expect(withJobLease(spec, async () => 1)).resolves.toEqual({
      ran: true,
      value: 1
    })
    expect(acquireKvLockMock).toHaveBeenCalledExactlyOnceWith('k', 60)
    expect(releaseKvLockMock).toHaveBeenCalledExactlyOnceWith('k', 'token')
  })

  it('默认不等: 锁被占着时立即返回 ran: false, 不执行', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    const fn = vi.fn()

    await expect(withJobLease(spec, fn)).resolves.toEqual({ ran: false })
    expect(acquireKvLockMock).toHaveBeenCalledTimes(1)
    expect(fn).not.toHaveBeenCalled()
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('给了 waitMs: 每 2 秒再试一次, 等到锁就执行', async () => {
    acquireKvLockMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('token')

    const running = withJobLease({ ...spec, waitMs: 10_000 }, async () => 1)
    await vi.advanceTimersByTimeAsync(4_000)

    await expect(running).resolves.toEqual({ ran: true, value: 1 })
    expect(acquireKvLockMock).toHaveBeenCalledTimes(3)
  })

  it('等过了 waitMs 仍拿不到就返回 ran: false', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    const fn = vi.fn()

    const running = withJobLease({ ...spec, waitMs: 5_000 }, fn)
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(running).resolves.toEqual({ ran: false })
    expect(fn).not.toHaveBeenCalled()
    // 0、2、4、6 秒各试一次: 第 6 秒那次已过时限, 拿不到就返回
    expect(acquireKvLockMock).toHaveBeenCalledTimes(4)
  })

  it('Redis 出错只重试 3 次 (锁被占着的等待不占这 3 次), 之后记一条 error', async () => {
    acquireKvLockMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))

    const running = withJobLease({ ...spec, waitMs: 60_000 }, vi.fn())
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(running).resolves.toEqual({ ran: false })
    expect(acquireKvLockMock).toHaveBeenCalledTimes(4)
    expect(kunLog).toHaveBeenCalledWith(
      'job.lease_acquire_failed',
      { job: 'drain' },
      expect.any(Error)
    )
  })

  it('等锁期间 signal 中止: 立即不等了, 不执行', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    const controller = new AbortController()
    const fn = vi.fn()

    const running = withJobLease(
      { ...spec, waitMs: 90_000, signal: controller.signal },
      fn
    )
    await vi.advanceTimersByTimeAsync(3_000)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    await expect(running).resolves.toEqual({ ran: false })
    expect(fn).not.toHaveBeenCalled()
    expect(acquireKvLockMock).toHaveBeenCalledTimes(2)
  })
})

describe('心跳', () => {
  it('每 TTL/3 续一次, 只续自己的 token; 结束之后不再续', async () => {
    const held = holdLease()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1)
    expect(renewKvLockMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(renewKvLockMock).toHaveBeenCalledExactlyOnceWith('k', 'token', 60)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(renewKvLockMock).toHaveBeenCalledTimes(4)

    held.finish()
    await held.running
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(renewKvLockMock).toHaveBeenCalledTimes(4)
    expect(held.lease().signal.aborted).toBe(false)
  })

  it('任务远长于 TTL 也一直持有: 租约与耗时无关', async () => {
    const held = holdLease()
    await vi.advanceTimersByTimeAsync(5 * DEFAULT_LEASE_TTL_SECONDS * 1000)

    expect(held.lease().signal.aborted).toBe(false)
    held.finish()
    await expect(held.running).resolves.toEqual({ ran: true, value: 'done' })
  })

  it('续租时发现锁已不是自己的: 立即中止 signal (LeaseLostError) 并记一条 error, 不再续', async () => {
    renewKvLockMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const held = holdLease()

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(held.lease().signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)

    const { signal } = held.lease()
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBeInstanceOf(LeaseLostError)
    expect(kunLog).toHaveBeenCalledExactlyOnceWith('job.lease_lost', {
      job: 'drain',
      reason: '续租时锁键已不存在或已换了持有者'
    })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(renewKvLockMock).toHaveBeenCalledTimes(2)

    held.finish()
    await held.running
  })

  it('续租出错一次不算丢, 连续两次才算; 中间成功一次就重新计数', async () => {
    renewKvLockMock
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
    const held = holdLease()

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(held.lease().signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(held.lease().signal.reason).toBeInstanceOf(LeaseLostError)
    expect(String(held.lease().signal.reason.message)).toContain(
      '连续 2 次续租出错'
    )

    held.finish()
    await held.running
  })

  // 事件循环被同步代码堵住超过一个 TTL: 心跳迟到, 锁键已过期, 续租返回 false
  it('心跳迟到到锁键过期之后: 判为丢失, 不当成仍在持有', async () => {
    renewKvLockMock.mockResolvedValue(false)
    const held = holdLease()

    await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_TTL_SECONDS * 1000 + 1)

    expect(held.lease().signal.reason).toBeInstanceOf(LeaseLostError)
    held.finish()
    await held.running
  })

  it('fn 在一次续租途中结束: 那次续租的结果不再触发丢失', async () => {
    const { promise: renewing, resolve: answerRenew } =
      Promise.withResolvers<boolean>()
    renewKvLockMock.mockReturnValueOnce(renewing)
    const held = holdLease()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)

    held.finish()
    await held.running
    answerRenew(false)
    await vi.advanceTimersByTimeAsync(0)

    expect(held.lease().signal.aborted).toBe(false)
    expect(kunLog).not.toHaveBeenCalled()
  })
})

describe('信号与收尾', () => {
  it('传入的 signal 中止时 lease.signal 同样中止, 原因原样带过来', async () => {
    const controller = new AbortController()
    let lease: JobLease | undefined
    const running = withJobLease(
      { ...spec, signal: controller.signal },
      async (held) => {
        lease = held
        await new Promise((resolve) =>
          held.signal.addEventListener('abort', resolve)
        )
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    const reason = new Error('stopping')
    controller.abort(reason)

    await running
    expect(lease!.signal.reason).toBe(reason)
    expect(releaseKvLockMock).toHaveBeenCalledOnce()
  })

  it('fn 抛错: 原样抛出, 照样释放', async () => {
    const error = new Error('boom')

    await expect(
      withJobLease(spec, async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(releaseKvLockMock).toHaveBeenCalledExactlyOnceWith('k', 'token')
  })

  it('释放出错只记日志, 不盖住结果', async () => {
    releaseKvLockMock.mockRejectedValue(new Error('down'))

    await expect(withJobLease(spec, async () => 1)).resolves.toEqual({
      ran: true,
      value: 1
    })
    expect(kunLog).toHaveBeenCalledWith(
      'job.lease_release_failed',
      { job: 'drain' },
      expect.any(Error)
    )
  })
})

describe('时间槽标记', () => {
  it('占到标记返回 true, 已被占返回 false; 标记不释放', async () => {
    acquireKvLockMock.mockResolvedValueOnce('token').mockResolvedValueOnce(null)
    const slot = { key: 'cron:reset-daily:lock', ttlSeconds: 3600 }

    await expect(claimJobSlot('reset_daily', slot)).resolves.toBe(true)
    await expect(claimJobSlot('reset_daily', slot)).resolves.toBe(false)
    expect(acquireKvLockMock).toHaveBeenCalledWith(
      'cron:reset-daily:lock',
      3600
    )
    expect(releaseKvLockMock).not.toHaveBeenCalled()
    expect(renewKvLockMock).not.toHaveBeenCalled()
  })
})

describe('停滞看门狗', () => {
  // 心跳与进度脱钩之后, 卡在没有上界的调用上 (连接被黑洞掉的 PG 查询) 的持有者会永远续租
  it('超过 stallMs 没有进展: 停止续租、立即释放、中止 signal 并记一条 error', async () => {
    const held = holdLease()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_STALL_MS - HEARTBEAT_MS)
    expect(held.lease().signal.aborted).toBe(false)
    const renewsBefore = renewKvLockMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)

    const { signal } = held.lease()
    expect(signal.reason).toBeInstanceOf(LeaseLostError)
    expect(String(signal.reason.message)).toContain('没有进展')
    expect(renewKvLockMock).toHaveBeenCalledTimes(renewsBefore)
    expect(releaseKvLockMock).toHaveBeenCalledExactlyOnceWith('k', 'token')
    expect(kunLog).toHaveBeenCalledExactlyOnceWith('job.lease_lost', {
      job: 'drain',
      reason: expect.stringContaining('没有进展')
    })

    held.finish()
    await held.running
  })

  it('每做完一个工作单元报一次进度: 持有远超 stallMs 也不算停滞', async () => {
    let lease: JobLease | undefined
    const { promise, resolve } = Promise.withResolvers<void>()
    const running = withJobLease(spec, async (held) => {
      lease = held
      await promise
    })
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_STALL_MS / 2)
      lease!.progress()
    }

    expect(lease!.signal.aborted).toBe(false)
    resolve()
    await running
  })

  it('stallMs 可以按作业放宽', async () => {
    let lease: JobLease | undefined
    const { promise, resolve } = Promise.withResolvers<void>()
    const running = withJobLease(
      { ...spec, stallMs: 60 * 60 * 1000 },
      async (held) => {
        lease = held
        await promise
      }
    )
    await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_STALL_MS * 3)

    expect(lease!.signal.aborted).toBe(false)
    resolve()
    await running
  })
})
