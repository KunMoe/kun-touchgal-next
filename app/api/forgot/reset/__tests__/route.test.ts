import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Characterization of POST /api/forgot/reset. Real argon2 hashing, real JWT session store
// over the in-memory Redis fake; the user table is a tiny in-memory map.

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

const db = vi.hoisted(() => {
  type Row = {
    id: number
    name: string
    email: string
    password: string
    security_stamp?: Date
  }
  const users = new Map<number, Row>()
  const queries: string[] = []
  return {
    users,
    queries,
    prisma: {
      user: {
        findUnique: async (args: { where: { id: number } }) => {
          queries.push(`findUnique ${JSON.stringify(args)}`)
          const row = users.get(args.where.id)
          return row ? { ...row } : null
        },
        // 凭据经 applyKunCredentialChange 写: 只按 id 的平铺 WHERE
        updateMany: async (args: {
          where: { id: number }
          data: Partial<Row>
        }) => {
          queries.push(`updateMany ${JSON.stringify(Object.keys(args.data))}`)
          const row = users.get(args.where.id)
          if (!row) {
            return { count: 0 }
          }
          users.set(row.id, { ...row, ...args.data })
          return { count: 1 }
        }
      }
    }
  }
})

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({ prisma: db.prisma }))

import {
  mintKunSessionToken,
  resolveKunSiteSession
} from '~/server/auth/session'
import { needsPasswordRehash, verifyPassword } from '~/server/auth/algorithm'
import { POST } from '~/app/api/forgot/reset/route'

// 会话仍然有效 (没被吊销): 经唯一的解析器判定
const verifyKunTokenPayload = async (token: string) => {
  const session = await resolveKunSiteSession(token)
  return session.kind === 'authenticated' ? session.payload : null
}

const UID = 7
const OTHER_UID = 8
const OLD_HASH = 'old-hash'
const NEW_PASSWORD = 'newpass456'
const INVALID_LINK = '重置链接无效或已过期, 请重新发起重置密码请求'
// argon2 (pure JS) can take hundreds of ms on a slow machine
const ARGON2_TIMEOUT = 60_000

const resetKey = (token: string) => `forgot:reset:${token}`

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const login = async (uid = UID) => {
  const token = (await mintKunSessionToken(uid)).token
  await flush()
  return token
}

const seedResetLink = (email: string, uid = UID) => {
  const token = randomUUID()
  redis.put(resetKey(token), JSON.stringify({ uid, email }), 30 * 60)
  return token
}

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest('http://localhost/api/forgot/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

const resetBody = (token: string, overrides: Record<string, unknown> = {}) => ({
  token,
  newPassword: NEW_PASSWORD,
  confirmPassword: NEW_PASSWORD,
  ...overrides
})

beforeEach(() => {
  redis.reset()
  db.users.clear()
  db.queries.length = 0
  db.users.set(UID, {
    id: UID,
    name: 'kun',
    email: 'kun@example.com',
    password: OLD_HASH
  })
  db.users.set(OTHER_UID, {
    id: OTHER_UID,
    name: 'other',
    email: 'other@example.com',
    password: OLD_HASH
  })
  vi.stubEnv('JWT_SECRET', 'jwt-test-secret')
  vi.stubEnv('JWT_ISS', 'kun-test-iss')
  vi.stubEnv('JWT_AUD', 'kun-test-aud')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/forgot/reset', () => {
  it('rejects a non-uuid token before reading Redis', async () => {
    const response = await post(resetBody('not-a-uuid'))

    expect(await response.json()).toBe('重置链接无效')
    expect(redis.calls).toEqual([])
  })

  it('rejects mismatched passwords before reading or consuming the reset key', async () => {
    const token = seedResetLink('kun@example.com')

    const response = await post(
      resetBody(token, { confirmPassword: 'other789x' })
    )

    expect(await response.json()).toBe('两次密码输入不一致')
    expect(redis.has(resetKey(token))).toBe(true)
    expect(redis.calls).toEqual([])
    expect(db.queries).toEqual([])
  })

  it('returns the invalid-link message for an unknown token without touching the DB', async () => {
    const response = await post(resetBody(randomUUID()))

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(INVALID_LINK)
    expect(db.queries).toEqual([])
  })

  it(
    'stores an argon2id hash of the new password, deletes every session of the uid, returns {}',
    async () => {
      const a = await login()
      const b = await login()
      const other = await login(OTHER_UID)
      // 只看重置本身的库访问 (签发测试会话时也读了 user 行)
      db.queries.length = 0
      const version = redis.get(`session:user:version:${UID}`)
      const token = seedResetLink('kun@example.com')

      const response = await post(resetBody(token))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({})
      const stored = db.users.get(UID)!.password
      expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
      expect(needsPasswordRehash(stored)).toBe(false)
      await expect(verifyPassword(NEW_PASSWORD, stored)).resolves.toBe(true)
      // 新密码与安全戳在同一条语句里写入 (重置之后签发早于它的令牌一律作废)
      expect(db.queries).toEqual([
        `findUnique ${JSON.stringify({
          where: { id: UID },
          select: { id: true, email: true }
        })}`,
        'updateMany ["password","security_stamp"]'
      ])
      expect(db.users.get(UID)!.security_stamp).toBeInstanceOf(Date)
      expect(redis.has(resetKey(token))).toBe(false)
      await expect(verifyKunTokenPayload(a)).resolves.toBeNull()
      await expect(verifyKunTokenPayload(b)).resolves.toBeNull()
      expect(redis.members(`access:sessions:${UID}`)).toEqual([])
      expect(redis.get(`session:user:version:${UID}`)).not.toBe(version)
      expect(await verifyKunTokenPayload(other)).not.toBeNull()
    },
    ARGON2_TIMEOUT
  )

  it(
    'consumes the reset key: a second use of the same link is rejected',
    async () => {
      const token = seedResetLink('kun@example.com')

      expect(await (await post(resetBody(token))).json()).toEqual({})
      const afterFirst = db.users.get(UID)!.password

      const second = await post(
        resetBody(token, {
          newPassword: 'another123',
          confirmPassword: 'another123'
        })
      )

      expect(await second.json()).toBe(INVALID_LINK)
      expect(db.users.get(UID)!.password).toBe(afterFirst)
    },
    ARGON2_TIMEOUT
  )

  it('rejects (and still consumes the key) when the stored email no longer matches the user', async () => {
    const session = await login()
    const token = seedResetLink('someone-else@example.com')

    const response = await post(resetBody(token))

    expect(await response.json()).toBe(INVALID_LINK)
    expect(redis.has(resetKey(token))).toBe(false)
    expect(db.users.get(UID)!.password).toBe(OLD_HASH)
    expect(await verifyKunTokenPayload(session)).not.toBeNull()
  })

  it('rejects (and still consumes the key) when the user no longer exists', async () => {
    const token = seedResetLink('ghost@example.com', 999)

    const response = await post(resetBody(token))

    expect(await response.json()).toBe(INVALID_LINK)
    expect(redis.has(resetKey(token))).toBe(false)
  })

  it(
    'compares the email case-insensitively',
    async () => {
      db.users.get(UID)!.email = 'Kun@Example.com'
      const token = seedResetLink('kun@EXAMPLE.COM')

      const response = await post(resetBody(token))

      expect(await response.json()).toEqual({})
      await expect(
        verifyPassword(NEW_PASSWORD, db.users.get(UID)!.password)
      ).resolves.toBe(true)
    },
    ARGON2_TIMEOUT
  )

  it(
    // 安全戳以影子模式发布: 删 Redis 键失败时旧会话还认 (切到强制模式后由安全戳拒绝, 那次提交翻转这一条)
    '[shadow mode] rejects after the password write when deleting sessions fails, and the old session still resolves',
    async () => {
      const session = await login()
      const token = seedResetLink('kun@example.com')
      redis.failNext(
        'delKvsAndRemoveKvSetMembers',
        new Error('redis del failed')
      )

      await expect(post(resetBody(token))).rejects.toThrow('redis del failed')
      await expect(
        verifyPassword(NEW_PASSWORD, db.users.get(UID)!.password)
      ).resolves.toBe(true)
      expect(await verifyKunTokenPayload(session)).not.toBeNull()
    },
    ARGON2_TIMEOUT
  )

  it(
    '[current: get-then-del consume is not atomic] a second request right after the first one read the reset key also succeeds',
    async () => {
      const token = seedResetLink('kun@example.com')
      let concurrent: unknown = null
      // runs once the first request's read of the reset key has returned
      redis.afterNext('getKv', async () => {
        const response = await post(
          resetBody(token, {
            newPassword: 'racer1234',
            confirmPassword: 'racer1234'
          })
        )
        concurrent = await response.json()
      })

      const first = await post(resetBody(token))

      expect(concurrent).toEqual({})
      expect(await first.json()).toEqual({})
      // the request that finished last wins the password column
      await expect(
        verifyPassword(NEW_PASSWORD, db.users.get(UID)!.password)
      ).resolves.toBe(true)
    },
    ARGON2_TIMEOUT
  )
})
