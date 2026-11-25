import { randomUUID } from 'crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  openRedisContract,
  redisContractUrl
} from '~/lib/__tests__/redisContract'
import type { RedisContract } from '~/lib/__tests__/redisContract'

// 作业租约的三条锁命令在真 Redis 上的语义 (运行方式见 lib/__tests__/redisContract.ts):
// 续租的 Lua 回的是整数, renewKvLock 靠它分辨「还是自己的锁」; mock 测不出回复的类型

describe.skipIf(!redisContractUrl)('job lease on real Redis', () => {
  let kv: RedisContract
  let redisLib: typeof import('~/lib/redis')
  let lease: typeof import('~/server/jobs/lease')
  let createdKeys: string[] = []

  beforeAll(async () => {
    kv = await openRedisContract()
    redisLib = await import('~/lib/redis')
    lease = await import('~/server/jobs/lease')
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (createdKeys.length) {
      await kv.del(...createdKeys)
    }
    createdKeys = []
  })

  afterAll(() => {
    kv?.close()
  })

  const newKey = () => {
    const key = `contract:lease:${randomUUID()}`
    createdKeys.push(key)
    return key
  }

  it('续租只对自己的 token 生效: 自己的返回 true 并刷新 TTL, 别人的、键已不在的返回 false', async () => {
    const key = newKey()
    const token = await redisLib.acquireKvLock(key, 60)
    expect(token).toEqual(expect.any(String))
    await kv.expire(key, 5)

    await expect(redisLib.renewKvLock(key, token!, 60)).resolves.toBe(true)
    expect(await kv.ttl(key)).toBeGreaterThan(55)

    await expect(redisLib.renewKvLock(key, 'other', 60)).resolves.toBe(false)
    expect(await kv.get(key)).toBe(token)

    await kv.del(key)
    await expect(redisLib.renewKvLock(key, token!, 60)).resolves.toBe(false)
    expect(await kv.get(key)).toBeNull()
  })

  it('持有期间锁键被删 (驱逐、手工 DEL): 下一次心跳判为丢失, 结束后不会删掉接手者的锁', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const key = newKey()
    let lost: unknown = null

    // TTL 3 秒, 心跳每 1 秒
    const running = lease.withJobLease(
      { name: 'contract', key, ttlSeconds: 3 },
      async ({ signal }) => {
        await kv.del(key)
        // 别的进程接手
        await kv.set(key, 'successor')
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve())
        )
        lost = signal.reason
      }
    )

    await expect(running).resolves.toEqual({ ran: true, value: undefined })
    expect(lost).toBeInstanceOf(lease.LeaseLostError)
    expect(await kv.get(key)).toBe('successor')
  })

  it('任务比 TTL 长得多时一直持有, 结束时释放', async () => {
    const key = newKey()

    const result = await lease.withJobLease(
      { name: 'contract', key, ttlSeconds: 1 },
      async ({ signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 2500))
        expect(await kv.get(key)).toEqual(expect.any(String))
        return signal.aborted
      }
    )

    expect(result).toEqual({ ran: true, value: false })
    expect(await kv.get(key)).toBeNull()
  })
})
