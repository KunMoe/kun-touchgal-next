import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  openRedisContract,
  redisContractUrl
} from '~/lib/__tests__/redisContract'
import type { RedisContract } from '~/lib/__tests__/redisContract'
import type {
  KunCounterGroup,
  KunCounterWindow
} from '~/server/abuse/windowCounter'

// 计数脚本在真 Redis 上的语义 (运行方式见 lib/__tests__/redisContract.ts)。凭据预算用到的
// 那部分 (一组、enforce、guard) 另由 server/auth 与登录 2FA 的两份契约守着; 这里管频率预算
// 才用到的: cost、多组、观察期、统计、止损键、重试时间

describe.skipIf(!redisContractUrl)('window counter on real Redis', () => {
  let kv: RedisContract
  let counter: typeof import('~/server/abuse/windowCounter')
  let createdKeys: string[] = []

  beforeAll(async () => {
    kv = await openRedisContract()
    counter = await import('~/server/abuse/windowCounter')
  })

  afterEach(async () => {
    if (createdKeys.length) {
      await kv.del(...createdKeys)
    }
    createdKeys = []
  })

  afterAll(() => {
    kv?.close()
  })

  const newKey = (kind: string) => {
    const key = `contract:counter:${kind}:${randomUUID()}`
    createdKeys.push(key)
    return key
  }

  const win = (limit: number, windowSeconds = 600): KunCounterWindow => ({
    key: newKey('window'),
    limit,
    windowSeconds
  })

  const group = (
    windows: KunCounterWindow[],
    extra: Partial<KunCounterGroup> = {}
  ): KunCounterGroup => ({ windows, enforce: true, ...extra })

  const withStats = () => ({ key: newKey('stats'), ttlSeconds: 8 * 86400 })

  const expectTtl = (ttl: number, seconds: number) => {
    expect(ttl).toBeLessThanOrEqual(seconds)
    expect(ttl).toBeGreaterThan(seconds - 5)
  }

  describe('cost', () => {
    it('charges the cost at once and refuses a cost that no longer fits', async () => {
      const day = win(10, 86400)

      await expect(
        counter.reserveWindows([group([day], { cost: 7 })])
      ).resolves.toEqual({ status: 'reserved', remaining: [3] })
      expect(await kv.get(day.key)).toBe('7')
      expectTtl(await kv.ttl(day.key), 86400)

      await expect(
        counter.reserveWindows([group([day], { cost: 4 })])
      ).resolves.toMatchObject({ status: 'exceeded', group: 0, window: 0 })
      expect(await kv.get(day.key)).toBe('7')

      await expect(
        counter.reserveWindows([group([day], { cost: 3 })])
      ).resolves.toEqual({ status: 'reserved', remaining: [0] })
    })

    it('never lets concurrent requests charge past the limit', async () => {
      const day = win(10)

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          counter.reserveWindows([group([day], { cost: 2 })])
        )
      )

      expect(
        results.filter((result) => result.status === 'reserved')
      ).toHaveLength(5)
      expect(await kv.get(day.key)).toBe('10')
    })

    it('reports the whole window when the cost alone exceeds the limit', async () => {
      const day = win(5, 3600)

      await expect(
        counter.reserveWindows([group([day], { cost: 6 })])
      ).resolves.toEqual({
        status: 'exceeded',
        group: 0,
        window: 0,
        retryAfterSec: 3600
      })
      expect(await kv.get(day.key)).toBeNull()
    })

    it('rejects a cost that is not a positive integer before touching Redis', async () => {
      const day = win(5)

      for (const cost of [0, -3, 1.5]) {
        await expect(
          counter.reserveWindows([group([day], { cost })])
        ).rejects.toThrow('positive integer')
      }
      expect(await kv.get(day.key)).toBeNull()
    })
  })

  describe('several groups in one call', () => {
    it('refuses the whole call when one enforcing group is full and charges none of the groups', async () => {
      const comment = win(10)
      const fetch = win(1, 300)
      const upstream = win(100)
      await counter.reserveWindows([group([fetch])])

      const result = await counter.reserveWindows([
        group([comment]),
        group([fetch, upstream])
      ])

      expect(result).toMatchObject({ status: 'exceeded', group: 1, window: 1 })
      expect(await kv.get(comment.key)).toBeNull()
      expect(await kv.get(upstream.key)).toBeNull()
      expect(await kv.get(fetch.key)).toBe('1')
    })

    it('reports how long the full window still has, rounded up to seconds', async () => {
      const minute = win(1, 60)
      await counter.reserveWindows([group([minute])])
      await kv.pexpire(minute.key, 41_200)

      await expect(counter.reserveWindows([group([minute])])).resolves.toEqual({
        status: 'exceeded',
        group: 0,
        window: 0,
        retryAfterSec: 42
      })
    })

    it('charges each group its own cost', async () => {
      const mention = win(100)
      const comment = win(10)

      await expect(
        counter.reserveWindows([
          group([mention], { cost: 30 }),
          group([comment])
        ])
      ).resolves.toEqual({ status: 'reserved', remaining: [70, 9] })
    })
  })

  describe('observe mode', () => {
    it('lets the request through when a window is full but counts none of that group', async () => {
      const burst = win(2)
      const day = win(100, 86400)
      const observed = group([burst, day], { enforce: false })
      await counter.reserveWindows([observed])
      await counter.reserveWindows([observed])

      await expect(counter.reserveWindows([observed])).resolves.toEqual({
        status: 'reserved',
        remaining: [-1, 98]
      })
      expect(await kv.get(burst.key)).toBe('2')
      expect(await kv.get(day.key)).toBe('2')
    })

    // 观察期的统计要能直接拿来定阈值: 同一串请求, 观察组记下的 exceeded 与 enforce 组拒掉的
    // 次数相同, 两边的计数器也走得一样 (每轮删掉短窗口的键, 当作它到期滚动)
    it('records as exceeded exactly the requests enforce would refuse, and keeps the same counters', async () => {
      const enforcedBurst = win(2)
      const enforcedDay = win(5, 86400)
      const observedBurst = win(2)
      const observedDay = win(5, 86400)
      const stats = withStats()
      const enforced = group([enforcedBurst, enforcedDay])
      const observed = group([observedBurst, observedDay], {
        enforce: false,
        stats
      })

      let refused = 0
      for (let round = 0; round < 3; round++) {
        for (let attempt = 0; attempt < 4; attempt++) {
          const result = await counter.reserveWindows([enforced])
          if (result.status === 'exceeded') {
            refused++
          }
          await expect(
            counter.reserveWindows([observed])
          ).resolves.toMatchObject({ status: 'reserved' })
        }
        await kv.del(enforcedBurst.key, observedBurst.key)
      }

      expect(refused).toBe(7)
      expect(await kv.hgetall(stats.key)).toEqual({
        total: '12',
        exceeded: '7'
      })
      expect(await kv.get(observedDay.key)).toBe(await kv.get(enforcedDay.key))
    })

    it('still refuses because of an enforcing group next to an observing one', async () => {
      const observedWindow = win(1)
      const enforcedWindow = win(1)
      await counter.reserveWindows([
        group([observedWindow], { enforce: false }),
        group([enforcedWindow])
      ])

      await expect(
        counter.reserveWindows([
          group([observedWindow], { enforce: false }),
          group([enforcedWindow])
        ])
      ).resolves.toMatchObject({ status: 'exceeded', group: 1, window: 1 })
    })
  })

  describe('retry time', () => {
    it('reports the longest wait among the full enforcing windows, not the first one', async () => {
      const burst = win(1, 600)
      const day = win(1, 86400)
      const both = group([burst, day])
      await counter.reserveWindows([both])

      await expect(counter.reserveWindows([both])).resolves.toMatchObject({
        status: 'exceeded',
        window: 0
      })
      const result = await counter.reserveWindows([both])
      expect(result.status).toBe('exceeded')
      expect(
        result.status === 'exceeded' && result.retryAfterSec
      ).toBeGreaterThan(86400 - 5)
    })

    it('ignores a full window of an observing group when reporting the wait', async () => {
      const observedDay = win(1, 86400)
      const enforcedMinute = win(1, 60)
      const call = () =>
        counter.reserveWindows([
          group([observedDay], { enforce: false }),
          group([enforcedMinute])
        ])
      await call()

      const result = await call()
      expect(result).toMatchObject({ status: 'exceeded', group: 1, window: 1 })
      expect(
        result.status === 'exceeded' && result.retryAfterSec
      ).toBeLessThanOrEqual(60)
    })
  })

  describe('stats', () => {
    it('counts every check and the ones that did not fit, enforcing or not, with a TTL set once', async () => {
      const stats = withStats()
      const burst = win(1)
      const observed = group([burst], { enforce: false, stats })
      const enforced = group([burst], { stats })

      await counter.reserveWindows([observed])
      await counter.reserveWindows([observed])
      await kv.expire(stats.key, 1000)
      await counter.reserveWindows([enforced])

      expect(await kv.hgetall(stats.key)).toEqual({
        total: '3',
        exceeded: '2'
      })
      expectTtl(await kv.ttl(stats.key), 1000)
    })

    it('on a refusal records only the groups that refused it', async () => {
      const refusingStats = withStats()
      const passingStats = withStats()
      const observedStats = withStats()
      const full = win(1)
      await counter.reserveWindows([group([full])])

      await counter.reserveWindows([
        group([full], { stats: refusingStats }),
        group([win(10)], { stats: passingStats }),
        group([win(1)], { enforce: false, stats: observedStats })
      ])

      expect(await kv.hgetall(refusingStats.key)).toEqual({
        total: '1',
        exceeded: '1'
      })
      expect(await kv.hgetall(passingStats.key)).toEqual({})
      expect(await kv.hgetall(observedStats.key)).toEqual({})
    })

    it('creates the hash with its TTL on the first check', async () => {
      const stats = withStats()

      await counter.reserveWindows([group([win(5)], { stats })])

      expect(await kv.hgetall(stats.key)).toEqual({ total: '1' })
      expectTtl(await kv.ttl(stats.key), 8 * 86400)
    })
  })

  describe('override key', () => {
    it('skips a group switched off: no check, no charge, no stats; other groups still count', async () => {
      const override = newKey('override')
      const stats = withStats()
      const full = win(1)
      const other = win(10)
      await counter.reserveWindows([group([full])])
      await kv.set(override, 'off')

      await expect(
        counter.reserveWindows([
          group([full], { overrideKey: override, stats }),
          group([other])
        ])
      ).resolves.toEqual({ status: 'reserved', remaining: [1, 9] })
      expect(await kv.get(full.key)).toBe('1')
      expect(await kv.get(other.key)).toBe('1')
      expect(await kv.hgetall(stats.key)).toEqual({})
    })

    it('enforces as usual when the override key holds anything but off or is absent', async () => {
      const override = newKey('override')
      const full = win(1)
      await counter.reserveWindows([group([full])])

      await expect(
        counter.reserveWindows([group([full], { overrideKey: override })])
      ).resolves.toMatchObject({ status: 'exceeded' })
      await kv.set(override, 'on')
      await expect(
        counter.reserveWindows([group([full], { overrideKey: override })])
      ).resolves.toMatchObject({ status: 'exceeded' })
    })
  })

  it('refuses to run without any window', async () => {
    await expect(counter.reserveWindows([group([])])).rejects.toThrow(
      'at least one window'
    )
  })
})
