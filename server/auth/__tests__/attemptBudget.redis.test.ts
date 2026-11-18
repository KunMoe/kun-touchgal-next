import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  contractSubjectId,
  openRedisContract,
  redisContractUrl
} from '~/lib/__tests__/redisContract'
import type { RedisContract } from '~/lib/__tests__/redisContract'
import type { BudgetDimension } from '~/server/auth/attemptBudget'

// 尝试预算原语在真 Redis 上的语义 (运行方式见 lib/__tests__/redisContract.ts)

describe.skipIf(!redisContractUrl)('attempt budget on real Redis', () => {
  let kv: RedisContract
  let budget: typeof import('~/server/auth/attemptBudget')
  let budgets: typeof import('~/server/auth/budgets')
  let login: typeof import('~/app/api/auth/_twoFactorChallenge')
  let createdKeys: string[] = []

  beforeAll(async () => {
    kv = await openRedisContract()
    budget = await import('~/server/auth/attemptBudget')
    budgets = await import('~/server/auth/budgets')
    login = await import('~/app/api/auth/_twoFactorChallenge')
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

  const track = <T extends { key: string }>(...items: T[]) => {
    createdKeys.push(...items.map((item) => item.key))
    return items
  }

  const dim = (
    limit: number,
    windowSeconds: number,
    extra: Partial<BudgetDimension> = {}
  ): BudgetDimension =>
    track({
      key: `contract:budget:${randomUUID()}`,
      limit,
      windowSeconds,
      ...extra
    })[0]

  const guardOf = async (value: string, ttlSeconds?: number) => {
    const [guard] = track({
      key: `contract:guard:${randomUUID()}`,
      expected: value
    })
    await kv.set(guard.key, value)
    if (ttlSeconds) {
      await kv.expire(guard.key, ttlSeconds)
    }
    return guard
  }

  const expectTtl = (ttl: number, seconds: number) => {
    expect(ttl).toBeLessThanOrEqual(seconds)
    expect(ttl).toBeGreaterThan(seconds - 5)
  }

  describe('reserving', () => {
    it('charges every dimension once and reports what is left of each', async () => {
      const wide = dim(10, 900)
      const narrow = dim(5, 300)

      await expect(budget.reserveAttempt([wide, narrow])).resolves.toEqual({
        allowed: true,
        remaining: [9, 4]
      })

      expect(await kv.get(wide.key)).toBe('1')
      expect(await kv.get(narrow.key)).toBe('1')
      expectTtl(await kv.ttl(wide.key), 900)
      expectTtl(await kv.ttl(narrow.key), 300)
    })

    it('rejects once any dimension is used up and then charges none of them', async () => {
      const wide = dim(10, 900)
      const narrow = dim(2, 900)

      await budget.reserveAttempt([wide, narrow])
      await expect(budget.reserveAttempt([wide, narrow])).resolves.toEqual({
        allowed: true,
        remaining: [8, 0]
      })
      await expect(budget.reserveAttempt([wide, narrow])).resolves.toEqual({
        allowed: false,
        reason: 'exhausted',
        dimension: narrow.key
      })

      expect(await kv.get(wide.key)).toBe('2')
      expect(await kv.get(narrow.key)).toBe('2')
    })

    it('names the first exhausted dimension in the order given', async () => {
      const first = dim(1, 900)
      const second = dim(1, 900)
      await budget.reserveAttempt([first, second])

      await expect(budget.reserveAttempt([first, second])).resolves.toEqual({
        allowed: false,
        reason: 'exhausted',
        dimension: first.key
      })
      await expect(budget.reserveAttempt([second, first])).resolves.toEqual({
        allowed: false,
        reason: 'exhausted',
        dimension: second.key
      })
    })

    it('starts the window at the first attempt and does not extend it', async () => {
      const counter = dim(10, 900)

      await budget.reserveAttempt([counter])
      await kv.expire(counter.key, 50)
      await budget.reserveAttempt([counter])

      expectTtl(await kv.ttl(counter.key), 50)
    })

    it('gives the budget back once the window has expired', async () => {
      const counter = dim(1, 900)
      await budget.reserveAttempt([counter])
      await expect(budget.reserveAttempt([counter])).resolves.toMatchObject({
        allowed: false
      })

      await kv.pexpire(counter.key, 30)
      await new Promise((resolve) => setTimeout(resolve, 80))

      await expect(budget.reserveAttempt([counter])).resolves.toEqual({
        allowed: true,
        remaining: [0]
      })
      expectTtl(await kv.ttl(counter.key), 900)
    })

    it('never lets concurrent requests reserve more than the limit', async () => {
      const wide = dim(10, 900)
      const narrow = dim(5, 900)

      const results = await Promise.all(
        Array.from({ length: 30 }, () => budget.reserveAttempt([wide, narrow]))
      )

      expect(results.filter((result) => result.allowed)).toHaveLength(5)
      expect(await kv.get(wide.key)).toBe('5')
      expect(await kv.get(narrow.key)).toBe('5')
    })
  })

  describe('settling', () => {
    it('clears every counter so that earlier failures are forgiven', async () => {
      const wide = dim(10, 900)
      const narrow = dim(5, 900)
      await budget.reserveAttempt([wide, narrow])
      await budget.reserveAttempt([wide, narrow])

      await expect(budget.settleSuccess([wide, narrow])).resolves.toBe(true)

      expect(await kv.get(wide.key)).toBeNull()
      expect(await kv.get(narrow.key)).toBeNull()
      await expect(budget.reserveAttempt([wide, narrow])).resolves.toEqual({
        allowed: true,
        remaining: [9, 4]
      })
    })
  })

  describe('guard', () => {
    it('rejects a missing guard and a guard holding another value without charging', async () => {
      const counter = dim(5, 900)
      const [missing] = track({
        key: `contract:guard:${randomUUID()}`,
        expected: '7'
      })
      const other = await guardOf('8')

      await expect(budget.reserveAttempt([counter], missing)).resolves.toEqual({
        allowed: false,
        reason: 'guard-missing'
      })
      await expect(
        budget.reserveAttempt([counter], { ...other, expected: '7' })
      ).resolves.toEqual({ allowed: false, reason: 'guard-mismatch' })

      expect(await kv.get(counter.key)).toBeNull()
    })

    it('lets a dimension expire together with the guard', async () => {
      const guard = await guardOf('7', 100)
      const scoped = dim(5, 600, { expiresWithGuard: true })
      const plain = dim(10, 900)

      await expect(
        budget.reserveAttempt([scoped, plain], guard)
      ).resolves.toEqual({ allowed: true, remaining: [4, 9] })

      expectTtl(await kv.ttl(scoped.key), 100)
      expectTtl(await kv.ttl(plain.key), 900)
    })

    it('falls back to the window when the guard has no TTL or there is no guard', async () => {
      const guard = await guardOf('7')
      const scoped = dim(5, 600, { expiresWithGuard: true })
      const unguarded = dim(5, 600, { expiresWithGuard: true })

      await budget.reserveAttempt([scoped], guard)
      await budget.reserveAttempt([unguarded])

      expectTtl(await kv.ttl(scoped.key), 600)
      expectTtl(await kv.ttl(unguarded.key), 600)
    })

    it('settles a guard exactly once and deletes it with the counters', async () => {
      const guard = await guardOf('7', 600)
      const counter = dim(5, 900)
      await budget.reserveAttempt([counter], guard)

      const results = await Promise.all(
        Array.from({ length: 8 }, () => budget.settleSuccess([counter], guard))
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await kv.get(guard.key)).toBeNull()
      expect(await kv.get(counter.key)).toBeNull()
      await expect(budget.reserveAttempt([counter], guard)).resolves.toEqual({
        allowed: false,
        reason: 'guard-missing'
      })
    })

    it('refuses to settle against a guard holding another value and deletes nothing', async () => {
      const guard = await guardOf('8', 600)
      const counter = dim(5, 900)
      await budget.reserveAttempt([counter], guard)

      await expect(
        budget.settleSuccess([counter], { ...guard, expected: '7' })
      ).resolves.toBe(false)

      expect(await kv.get(guard.key)).toBe('8')
      expect(await kv.get(counter.key)).toBe('1')
    })
  })

  describe('step-up buckets', () => {
    const ip = '203.0.113.9'

    it('uses the login thresholds: ten per user, five per user and IP, fifteen minutes', async () => {
      const uid = contractSubjectId()
      const dims = track(...budgets.stepUpSecondFactorDims(uid, ip))

      const results = []
      for (let attempt = 0; attempt < 6; attempt++) {
        results.push(await budget.reserveAttempt(dims))
      }

      expect(results.slice(0, 5).map((result) => result.allowed)).toEqual([
        true,
        true,
        true,
        true,
        true
      ])
      expect(results[5]).toEqual({
        allowed: false,
        reason: 'exhausted',
        dimension: dims[1].key
      })
      expectTtl(await kv.ttl(dims[0].key), 900)
      expectTtl(await kv.ttl(dims[1].key), 900)
      // IP 不以明文进键名
      expect(dims[1].key).not.toContain(ip)

      // 换 IP 可以继续, 直到 uid 维度的 10 次用完
      const rotated = (n: number) =>
        track(...budgets.stepUpSecondFactorDims(uid, `198.51.100.${n}`))
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(
          budget.reserveAttempt(rotated(attempt))
        ).resolves.toMatchObject({ allowed: true })
      }
      await expect(budget.reserveAttempt(rotated(9))).resolves.toEqual({
        allowed: false,
        reason: 'exhausted',
        dimension: dims[0].key
      })
    })

    it('has no IP dimension when the client IP is unknown', () => {
      expect(budgets.stepUpSecondFactorDims(7, '')).toHaveLength(1)
      expect(budgets.stepUpPasswordDims(7, '')).toHaveLength(1)
    })

    it('keeps the password bucket apart from the second-factor bucket', async () => {
      const uid = contractSubjectId()
      const secondFactor = track(...budgets.stepUpSecondFactorDims(uid, ''))
      const password = track(...budgets.stepUpPasswordDims(uid, ''))

      for (let attempt = 0; attempt < 10; attempt++) {
        await budget.reserveAttempt(secondFactor)
      }

      await expect(budget.reserveAttempt(secondFactor)).resolves.toMatchObject({
        allowed: false
      })
      await expect(budget.reserveAttempt(password)).resolves.toEqual({
        allowed: true,
        remaining: [9]
      })
    })

    // 判别用例: 持被窃会话的人在设置页烧光额度, 不得让受害者过不了登录的 2FA
    it('does not touch the login budget when the settings budget is burnt', async () => {
      const uid = contractSubjectId()
      const dims = track(...budgets.stepUpSecondFactorDims(uid, ip))
      for (let attempt = 0; attempt < 10; attempt++) {
        await budget.reserveAttempt([dims[0]])
      }
      await expect(budget.reserveAttempt(dims)).resolves.toMatchObject({
        allowed: false
      })

      const jti = randomUUID()
      createdKeys.push(
        `auth:2fa:challenge:${jti}`,
        `auth:2fa:challenge-attempts:${jti}`,
        `auth:2fa:uid-attempts:${uid}`
      )
      await login.createTwoFactorChallenge(jti, uid)

      await expect(
        login.reserveTwoFactorAttempt(jti, uid, '')
      ).resolves.toEqual({ allowed: true, remainingAttempts: 4 })
    })
  })
})
