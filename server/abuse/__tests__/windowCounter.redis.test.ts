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
    it('lets the request through when a window is full and does not count it there, but counts the windows that fit', async () => {
      const burst = win(2)
      const day = win(100, 86400)
      const observed = group([burst, day], { enforce: false })
      await counter.reserveWindows([observed])
      await counter.reserveWindows([observed])

      await expect(counter.reserveWindows([observed])).resolves.toEqual({
        status: 'reserved',
        remaining: [-1, 97]
      })
      expect(await kv.get(burst.key)).toBe('2')
      expect(await kv.get(day.key)).toBe('3')
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
