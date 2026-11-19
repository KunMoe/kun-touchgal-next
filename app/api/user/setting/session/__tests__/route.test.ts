import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Characterization of /api/user/setting/session (GET list, POST revoke others, DELETE one).
// Authentication runs the real chain verifyHeaderCookie → server/viewer → jwt over the
// in-memory Redis fake; the user row comes from a tiny prisma fake.

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

const { users, cookieDeletes, cookieSets, stampWrites } = vi.hoisted(() => ({
  users: new Map<
    number,
    {
      id: number
      name: string
      role: number
      status: number
      security_stamp?: Date | null
    }
  >(),
  cookieSets: [] as { name: string; value: string }[],
  cookieDeletes: [] as string[],
  stampWrites: [] as { uid: number; data: Record<string, unknown> }[]
}))

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findUnique: async (args: { where: { id: number } }) => {
        const row = users.get(args.where.id)
        return row ? { ...row, blocked_tag_ids: [] } : null
      },
      // 「退出其它设备」只写安全戳 (策略不刷新时 data 为空, Prisma 不发查询)
      updateMany: async (args: {
        where: { id: number } & Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        stampWrites.push({ uid: args.where.id, data: args.data })
        const row = users.get(args.where.id)
        if (!row || !Object.keys(args.data).length) {
          return { count: 0 }
        }
        // 以当前令牌带的戳为条件 (null 或毫秒值相等)
        if ('security_stamp' in args.where) {
          const expected = args.where.security_stamp as Date | null
          const actual = row.security_stamp ?? null
          if ((expected?.getTime() ?? null) !== (actual?.getTime() ?? null)) {
            return { count: 0 }
          }
        }
        users.set(row.id, { ...row, ...args.data })
        return { count: 1 }
      }
    }
  }
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    delete: (name: string) => {
      cookieDeletes.push(name)
    },
    set: (name: string, value: string) => {
      cookieSets.push({ name, value })
    }
  })
}))

import {
  mintKunSessionToken,
  resolveKunSiteSession
} from '~/server/auth/session'
import { DELETE, GET, POST } from '~/app/api/user/setting/session/route'

// 会话仍然有效 (没被吊销): 经唯一的解析器判定
const verifyKunTokenPayload = async (token: string) => {
  const session = await resolveKunSiteSession(token)
  return session.kind === 'authenticated' ? session.payload : null
}

const UID = 7
const OTHER_UID = 8
const T0 = new Date('2027-01-15T08:00:00.000Z').getTime()
const AUTH_COOKIE = 'kun-galgame-patch-moe-token'
const URL_BASE = 'http://localhost/api/user/setting/session'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const login = async (uid = UID, userAgent = 'ua') => {
  const { token } = await mintKunSessionToken(uid, {
    userAgent,
    ip: '203.0.113.8'
  })
  await flush()
  const jti = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString()
  ).jti as string
  return { token, jti }
}

const request = (method: string, token?: string, query = '') =>
  new NextRequest(`${URL_BASE}${query}`, {
    method,
    headers: token ? { cookie: `${AUTH_COOKIE}=${token}` } : {}
  })

beforeEach(() => {
  redis.reset()
  users.clear()
  cookieDeletes.length = 0
  cookieSets.length = 0
  stampWrites.length = 0
  users.set(UID, { id: UID, name: 'kun', role: 1, status: 0 })
  users.set(OTHER_UID, { id: OTHER_UID, name: 'other', role: 1, status: 0 })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.stubEnv('JWT_SECRET', 'jwt-test-secret')
  vi.stubEnv('JWT_ISS', 'kun-test-iss')
  vi.stubEnv('JWT_AUD', 'kun-test-aud')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('GET /api/user/setting/session', () => {
  it('lists the sessions newest first with isCurrent on the requesting one', async () => {
    const current = await login(UID, 'current-ua')
    vi.setSystemTime(T0 + 60_000)
    const other = await login(UID, 'other-ua')

    const response = await GET(request('GET', current.token))

    expect(await response.json()).toEqual([
      {
        id: other.jti,
        userAgent: 'other-ua',
        ip: '203.0.113.8',
        createdAt: T0 + 60_000,
        lastActiveAt: T0 + 60_000,
        isCurrent: false
      },
      {
        id: current.jti,
        userAgent: 'current-ua',
        ip: '203.0.113.8',
        createdAt: T0,
        lastActiveAt: T0,
        isCurrent: true
      }
    ])
  })

  it('returns 用户未登录 (status 200) without a valid session', async () => {
    const response = await GET(request('GET'))

    expect(response.status).toBe(200)
    expect(await response.json()).toBe('用户未登录')
  })
})

describe('POST /api/user/setting/session', () => {
  it('戳在这个请求通过鉴权之后被别处刷新过: 不删别人的会话, 不重签', async () => {
    const current = await login()
    const b = await login()
    // 别处 (重置密码、另一台设备) 刚把戳刷新了, 这个会话的令牌还带着旧戳
    users.set(UID, { ...users.get(UID)!, security_stamp: new Date(T0 - 1) })
    stampWrites.length = 0

    const response = await POST(request('POST', current.token))

    expect(await response.json()).toBe('登录状态已变化, 请重新登录')
    expect(cookieSets).toEqual([])
    expect(await verifyKunTokenPayload(b.token)).not.toBeNull()
  })

  it('revokes the other sessions, keeps the current one, returns { revokedCount }', async () => {
    const current = await login()
    const b = await login()
    const c = await login()
    const foreign = await login(OTHER_UID)

    const response = await POST(request('POST', current.token))

    expect(await response.json()).toEqual({ revokedCount: 2 })
    await expect(verifyKunTokenPayload(b.token)).resolves.toBeNull()
    await expect(verifyKunTokenPayload(c.token)).resolves.toBeNull()
    expect(await verifyKunTokenPayload(foreign.token)).not.toBeNull()
    expect(cookieDeletes).toEqual([])

    // 策略表 other-sessions-revoked: 刷新安全戳 (被退出的设备手里的 OIDC 令牌一并作废),
    // 当前会话以同一个 jti 带着新戳重签并写回 cookie
    expect(stampWrites).toEqual([
      { uid: UID, data: { security_stamp: new Date(T0) } }
    ])
    expect(cookieSets).toHaveLength(1)
    const reissued = cookieSets[0]
    expect(reissued.name).toBe(AUTH_COOKIE)
    expect(
      JSON.parse(
        Buffer.from(reissued.value.split('.')[1], 'base64url').toString()
      )
    ).toMatchObject({ jti: current.jti, cs: T0 })
    expect(await verifyKunTokenPayload(reissued.value)).not.toBeNull()
    // 手里的旧令牌对不上 Redis 里的新令牌了
    await expect(verifyKunTokenPayload(current.token)).resolves.toBeNull()
  })

  it('returns 用户未登录 without a valid session', async () => {
    const response = await POST(request('POST'))

    expect(await response.json()).toBe('用户未登录')
  })
})

describe('DELETE /api/user/setting/session', () => {
  it('revokes a non-current session without touching the cookie', async () => {
    const current = await login()
    const other = await login()

    const response = await DELETE(
      request('DELETE', current.token, `?sessionId=${other.jti}`)
    )

    expect(await response.json()).toEqual({ revokedCurrent: false })
    await expect(verifyKunTokenPayload(other.token)).resolves.toBeNull()
    expect(await verifyKunTokenPayload(current.token)).not.toBeNull()
    expect(cookieDeletes).toEqual([])
  })

  it('revokes the current session and deletes the auth cookie', async () => {
    const current = await login()

    const response = await DELETE(
      request('DELETE', current.token, `?sessionId=${current.jti}`)
    )

    expect(await response.json()).toEqual({ revokedCurrent: true })
    expect(cookieDeletes).toEqual([AUTH_COOKIE])
    await expect(verifyKunTokenPayload(current.token)).resolves.toBeNull()
  })

  it('returns 登录会话不存在或已失效 for an unknown session id', async () => {
    const current = await login()

    const response = await DELETE(
      request('DELETE', current.token, `?sessionId=${randomUUID()}`)
    )

    expect(await response.json()).toBe('登录会话不存在或已失效')
    expect(cookieDeletes).toEqual([])
  })

  it("cannot revoke another user's session (looked up under the caller's uid)", async () => {
    const current = await login()
    const foreign = await login(OTHER_UID)

    const response = await DELETE(
      request('DELETE', current.token, `?sessionId=${foreign.jti}`)
    )

    expect(await response.json()).toBe('登录会话不存在或已失效')
    expect(await verifyKunTokenPayload(foreign.token)).not.toBeNull()
  })

  it('validates the session id before checking the session', async () => {
    const invalid = await DELETE(
      request('DELETE', undefined, '?sessionId=nope')
    )
    const unauthenticated = await DELETE(
      request('DELETE', undefined, `?sessionId=${randomUUID()}`)
    )

    expect(await invalid.json()).toBe('登录会话 ID 无效')
    expect(await unauthenticated.json()).toBe('用户未登录')
    expect(redis.calls).toEqual([])
  })
})
