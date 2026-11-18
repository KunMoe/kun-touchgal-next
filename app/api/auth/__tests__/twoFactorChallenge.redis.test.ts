import { createHash, randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  contractSubjectId,
  openRedisContract,
  redisContractUrl
} from '~/lib/__tests__/redisContract'
import type { RedisContract } from '~/lib/__tests__/redisContract'

// 登录 2FA 尝试预算在真 Redis 上的语义 (运行方式见 lib/__tests__/redisContract.ts)。
// 期望值全部是字面量: 换实现 (T07 片 4 把预约迁到 server/auth/attemptBudget) 时本文件
// 一个字不改也必须全绿, 这就是「新旧脚本跑同一张场景表」

const CHALLENGE_TTL = 600
const WINDOW = 900

const challengeKey = (jti: string) => `auth:2fa:challenge:${jti}`
const attemptsKey = (jti: string) => `auth:2fa:challenge-attempts:${jti}`
const uidKey = (uid: number) => `auth:2fa:uid-attempts:${uid}`
const uidIpKey = (uid: number, ip: string) =>
  `auth:2fa:uid-ip-attempts:${uid}:${
    ip ? createHash('sha256').update(ip).digest('hex') : 'none'
  }`

describe.skipIf(!redisContractUrl)('login 2FA budget on real Redis', () => {
  let kv: RedisContract
  let budget: typeof import('~/app/api/auth/_twoFactorChallenge')
  let createdKeys: string[] = []

  beforeAll(async () => {
    kv = await openRedisContract()
    budget = await import('~/app/api/auth/_twoFactorChallenge')
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

  const newUid = () => {
    const uid = contractSubjectId()
    createdKeys.push(uidKey(uid), uidIpKey(uid, ''))
    return uid
  }

  const newChallenge = async (uid: number) => {
    const jti = randomUUID()
    createdKeys.push(challengeKey(jti), attemptsKey(jti))
    await budget.createTwoFactorChallenge(jti, uid)
    return jti
  }

  const ipOf = (uid: number, n: number) => {
    const ip = `203.0.113.${n}`
    createdKeys.push(uidIpKey(uid, ip))
    return ip
  }

  const reserveTimes = async (
    times: number,
    jti: string,
    uid: number,
    ip: (index: number) => string
  ) => {
    const results = []
    for (let index = 0; index < times; index++) {
      results.push(await budget.reserveTwoFactorAttempt(jti, uid, ip(index)))
    }
    return results
  }

  const expectTtl = (ttl: number, seconds: number) => {
    expect(ttl).toBeLessThanOrEqual(seconds)
    expect(ttl).toBeGreaterThan(seconds - 5)
  }

  describe('challenge guard', () => {
    it('rejects a missing challenge as expired and creates no counters', async () => {
      const uid = newUid()
      const jti = randomUUID()
      const ip = ipOf(uid, 1)

      await expect(
        budget.reserveTwoFactorAttempt(jti, uid, ip)
      ).resolves.toEqual({ allowed: false, reason: 'expired' })

      expect(await kv.get(attemptsKey(jti))).toBeNull()
      expect(await kv.get(uidKey(uid))).toBeNull()
      expect(await kv.get(uidIpKey(uid, ip))).toBeNull()
    })

    it('rejects a challenge bound to another user and charges neither user', async () => {
      const owner = newUid()
      const other = newUid()
      const jti = await newChallenge(owner)
      const ip = ipOf(other, 1)

      await expect(
        budget.reserveTwoFactorAttempt(jti, other, ip)
      ).resolves.toEqual({ allowed: false, reason: 'invalid' })

      expect(await kv.get(attemptsKey(jti))).toBeNull()
      expect(await kv.get(uidKey(owner))).toBeNull()
      expect(await kv.get(uidKey(other))).toBeNull()
      expect(await kv.get(uidIpKey(other, ip))).toBeNull()
    })

    it('creates the challenge with a 10-minute TTL and refuses a duplicate id', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)

      expect(await kv.get(challengeKey(jti))).toBe(String(uid))
      expectTtl(await kv.ttl(challengeKey(jti)), CHALLENGE_TTL)
      await expect(budget.isTwoFactorChallengeActive(jti, uid)).resolves.toBe(
        true
      )
      await expect(
        budget.isTwoFactorChallengeActive(jti, uid + 1)
      ).resolves.toBe(false)
      await expect(budget.createTwoFactorChallenge(jti, uid)).rejects.toThrow(
        'Failed to create unique 2FA challenge'
      )
    })
  })

  describe('reservation', () => {
    it('charges all three dimensions once and reports the remaining challenge attempts', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)
      const ip = ipOf(uid, 1)

      await expect(
        budget.reserveTwoFactorAttempt(jti, uid, ip)
      ).resolves.toEqual({ allowed: true, remainingAttempts: 4 })

      expect(await kv.get(attemptsKey(jti))).toBe('1')
      expect(await kv.get(uidKey(uid))).toBe('1')
      expect(await kv.get(uidIpKey(uid, ip))).toBe('1')
      expectTtl(await kv.ttl(attemptsKey(jti)), CHALLENGE_TTL)
      expectTtl(await kv.ttl(uidKey(uid)), WINDOW)
      expectTtl(await kv.ttl(uidIpKey(uid, ip)), WINDOW)
    })

    it('allows five attempts per challenge and then rejects without charging', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)
      const results = await reserveTimes(6, jti, uid, (index) =>
        ipOf(uid, index)
      )

      expect(results).toEqual([
        { allowed: true, remainingAttempts: 4 },
        { allowed: true, remainingAttempts: 3 },
        { allowed: true, remainingAttempts: 2 },
        { allowed: true, remainingAttempts: 1 },
        { allowed: true, remainingAttempts: 0 },
        { allowed: false, reason: 'challenge' }
      ])
      expect(await kv.get(attemptsKey(jti))).toBe('5')
      expect(await kv.get(uidKey(uid))).toBe('5')
      // 被拒的第 6 次来自一个新 IP: 它的计数键不应出现
      expect(await kv.get(uidIpKey(uid, ipOf(uid, 5)))).toBeNull()
    })

    it('allows ten attempts per user across challenges', async () => {
      const uid = newUid()
      const first = await newChallenge(uid)
      const second = await newChallenge(uid)
      const third = await newChallenge(uid)

      await reserveTimes(5, first, uid, (index) => ipOf(uid, index))
      const secondResults = await reserveTimes(5, second, uid, (index) =>
        ipOf(uid, 10 + index)
      )
      expect(secondResults.at(-1)).toEqual({
        allowed: true,
        remainingAttempts: 0
      })

      await expect(
        budget.reserveTwoFactorAttempt(third, uid, ipOf(uid, 20))
      ).resolves.toEqual({ allowed: false, reason: 'uid' })
      expect(await kv.get(uidKey(uid))).toBe('10')
      expect(await kv.get(attemptsKey(third))).toBeNull()
    })

    it('allows five attempts per user and IP across challenges', async () => {
      const uid = newUid()
      const first = await newChallenge(uid)
      const second = await newChallenge(uid)
      const ip = ipOf(uid, 1)

      await reserveTimes(5, first, uid, () => ip)

      await expect(
        budget.reserveTwoFactorAttempt(second, uid, ip)
      ).resolves.toEqual({ allowed: false, reason: 'uidIp' })
      expect(await kv.get(uidIpKey(uid, ip))).toBe('5')
      expect(await kv.get(uidKey(uid))).toBe('5')
      expect(await kv.get(attemptsKey(second))).toBeNull()

      // 换一个 IP 仍可继续, 直到 uid 维度用完
      await expect(
        budget.reserveTwoFactorAttempt(second, uid, ipOf(uid, 2))
      ).resolves.toEqual({ allowed: true, remainingAttempts: 4 })
    })

    it('skips the IP dimension entirely when the client IP is unknown', async () => {
      const uid = newUid()
      const first = await newChallenge(uid)
      const second = await newChallenge(uid)
      const third = await newChallenge(uid)

      await reserveTimes(5, first, uid, () => '')
      await reserveTimes(5, second, uid, () => '')

      await expect(
        budget.reserveTwoFactorAttempt(third, uid, '')
      ).resolves.toEqual({ allowed: false, reason: 'uid' })
      expect(await kv.get(uidIpKey(uid, ''))).toBeNull()
    })

    it('reports the challenge limit before the user limit, and the user limit before the IP limit', async () => {
      const uid = newUid()
      const first = await newChallenge(uid)
      const second = await newChallenge(uid)
      const third = await newChallenge(uid)
      const ip = ipOf(uid, 1)

      await reserveTimes(5, first, uid, () => ip)
      await reserveTimes(5, second, uid, (index) => ipOf(uid, 10 + index))

      // first: 三个维度都已用完
      await expect(
        budget.reserveTwoFactorAttempt(first, uid, ip)
      ).resolves.toEqual({ allowed: false, reason: 'challenge' })
      // third: challenge 维度是新的, uid 与该 IP 都已用完
      await expect(
        budget.reserveTwoFactorAttempt(third, uid, ip)
      ).resolves.toEqual({ allowed: false, reason: 'uid' })
    })

    it('never over-reserves under concurrent requests on one challenge', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          budget.reserveTwoFactorAttempt(jti, uid, '')
        )
      )

      const allowed = results.filter((result) => result.allowed)
      expect(
        allowed
          .map((result) => (result.allowed ? result.remainingAttempts : -1))
          .sort()
      ).toEqual([0, 1, 2, 3, 4])
      expect(results.filter((result) => !result.allowed)).toEqual(
        Array.from({ length: 15 }, () => ({
          allowed: false,
          reason: 'challenge'
        }))
      )
      expect(await kv.get(attemptsKey(jti))).toBe('5')
      expect(await kv.get(uidKey(uid))).toBe('5')
    })

    it('never over-reserves the user budget under concurrent challenges', async () => {
      const uid = newUid()
      const challenges = await Promise.all(
        Array.from({ length: 6 }, () => newChallenge(uid))
      )

      const results = await Promise.all(
        challenges.flatMap((jti) =>
          Array.from({ length: 5 }, () =>
            budget.reserveTwoFactorAttempt(jti, uid, '')
          )
        )
      )

      expect(results.filter((result) => result.allowed)).toHaveLength(10)
      expect(results.filter((result) => !result.allowed)).toEqual(
        Array.from({ length: 20 }, () => ({ allowed: false, reason: 'uid' }))
      )
      expect(await kv.get(uidKey(uid))).toBe('10')
    })
  })

  describe('windows', () => {
    it('gives the challenge counter the remaining lifetime of the challenge', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)
      await kv.expire(challengeKey(jti), 100)

      await budget.reserveTwoFactorAttempt(jti, uid, '')

      expectTtl(await kv.ttl(attemptsKey(jti)), 100)
    })

    it('falls back to ten minutes when the challenge has no TTL', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)
      await kv.persist(challengeKey(jti))

      await budget.reserveTwoFactorAttempt(jti, uid, '')

      expectTtl(await kv.ttl(attemptsKey(jti)), CHALLENGE_TTL)
    })

    it('starts each window at the first attempt and does not extend it', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)
      const ip = ipOf(uid, 1)

      await budget.reserveTwoFactorAttempt(jti, uid, ip)
      await kv.expire(attemptsKey(jti), 60)
      await kv.expire(uidKey(uid), 50)
      await kv.expire(uidIpKey(uid, ip), 40)
      await budget.reserveTwoFactorAttempt(jti, uid, ip)

      expectTtl(await kv.ttl(attemptsKey(jti)), 60)
      expectTtl(await kv.ttl(uidKey(uid)), 50)
      expectTtl(await kv.ttl(uidIpKey(uid, ip)), 40)
    })

    it('gives the budget back once the window has expired', async () => {
      const uid = newUid()
      const first = await newChallenge(uid)
      const second = await newChallenge(uid)
      const third = await newChallenge(uid)
      await reserveTimes(5, first, uid, () => '')
      await reserveTimes(5, second, uid, () => '')

      await kv.pexpire(uidKey(uid), 30)
      await new Promise((resolve) => setTimeout(resolve, 80))

      await expect(
        budget.reserveTwoFactorAttempt(third, uid, '')
      ).resolves.toEqual({ allowed: true, remainingAttempts: 4 })
      expect(await kv.get(uidKey(uid))).toBe('1')
      expectTtl(await kv.ttl(uidKey(uid)), WINDOW)
    })
  })

  describe('consuming the challenge', () => {
    it('deletes the challenge and the counters of the succeeding request', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)
      const ip = ipOf(uid, 1)
      await budget.reserveTwoFactorAttempt(jti, uid, ip)

      await expect(
        budget.consumeTwoFactorChallenge(jti, uid, ip)
      ).resolves.toBe(true)

      expect(await kv.get(challengeKey(jti))).toBeNull()
      expect(await kv.get(attemptsKey(jti))).toBeNull()
      expect(await kv.get(uidKey(uid))).toBeNull()
      expect(await kv.get(uidIpKey(uid, ip))).toBeNull()
    })

    it("leaves other IPs' counters alone", async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)
      const failing = ipOf(uid, 1)
      const succeeding = ipOf(uid, 2)
      await budget.reserveTwoFactorAttempt(jti, uid, failing)
      await budget.reserveTwoFactorAttempt(jti, uid, succeeding)

      await budget.consumeTwoFactorChallenge(jti, uid, succeeding)

      expect(await kv.get(uidIpKey(uid, failing))).toBe('1')
      expect(await kv.get(uidIpKey(uid, succeeding))).toBeNull()
    })

    it('touches no IP counter when the client IP is unknown', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)
      const ip = ipOf(uid, 1)
      await budget.reserveTwoFactorAttempt(jti, uid, ip)
      // 没有 IP 的请求不读写 :none 这个键; 预先放一个值, 结算后它应原样还在
      await kv.set(uidIpKey(uid, ''), 'untouched')

      await expect(
        budget.consumeTwoFactorChallenge(jti, uid, '')
      ).resolves.toBe(true)

      expect(await kv.get(uidKey(uid))).toBeNull()
      expect(await kv.get(uidIpKey(uid, ip))).toBe('1')
      expect(await kv.get(uidIpKey(uid, ''))).toBe('untouched')
    })

    it('refuses a wrong user or a missing challenge and deletes nothing', async () => {
      const uid = newUid()
      const other = newUid()
      const jti = await newChallenge(uid)
      const ip = ipOf(uid, 1)
      await budget.reserveTwoFactorAttempt(jti, uid, ip)

      await expect(
        budget.consumeTwoFactorChallenge(jti, other, ip)
      ).resolves.toBe(false)
      await expect(
        budget.consumeTwoFactorChallenge(randomUUID(), uid, ip)
      ).resolves.toBe(false)

      expect(await kv.get(challengeKey(jti))).toBe(String(uid))
      expect(await kv.get(attemptsKey(jti))).toBe('1')
      expect(await kv.get(uidKey(uid))).toBe('1')
      expect(await kv.get(uidIpKey(uid, ip))).toBe('1')
    })

    it('can be consumed only once, also under concurrency', async () => {
      const uid = newUid()
      const jti = await newChallenge(uid)

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          budget.consumeTwoFactorChallenge(jti, uid, '')
        )
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      await expect(
        budget.reserveTwoFactorAttempt(jti, uid, '')
      ).resolves.toEqual({ allowed: false, reason: 'expired' })
    })

    it('forgives earlier failures: a success resets the user budget', async () => {
      const uid = newUid()
      const first = await newChallenge(uid)
      const second = await newChallenge(uid)
      const third = await newChallenge(uid)
      await reserveTimes(5, first, uid, () => '')
      await reserveTimes(4, second, uid, () => '')

      await budget.consumeTwoFactorChallenge(second, uid, '')

      await expect(
        budget.reserveTwoFactorAttempt(third, uid, '')
      ).resolves.toEqual({ allowed: true, remainingAttempts: 4 })
      expect(await kv.get(uidKey(uid))).toBe('1')
      // 另一个 challenge 自己的计数不受这次成功影响
      expect(await kv.get(attemptsKey(first))).toBe('5')
    })
  })
})
