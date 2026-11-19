import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Characterization of /api/user/setting/session (GET list, POST revoke others, DELETE one).
// Authentication runs the real chain verifyHeaderCookie → server/viewer → jwt over the
// in-memory Redis fake; the user row comes from a tiny prisma fake.

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

const { users, cookieDeletes } = vi.hoisted(() => ({
  users: new Map<
    number,
    { id: number; name: string; role: number; status: number }
  >(),
  cookieDeletes: [] as string[]
}))

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findUnique: async (args: { where: { id: number } }) => {
        const row = users.get(args.where.id)
        return row ? { ...row, blocked_tag_ids: [] } : null
      }
    }
  }
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    delete: (name: string) => {
      cookieDeletes.push(name)
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
  it('revokes the other sessions, keeps the current one, returns { revokedCount }', async () => {
    const current = await login()
    const b = await login()
    const c = await login()
    const foreign = await login(OTHER_UID)

    const response = await POST(request('POST', current.token))

    expect(await response.json()).toEqual({ revokedCount: 2 })
    expect(await verifyKunTokenPayload(current.token)).not.toBeNull()
    await expect(verifyKunTokenPayload(b.token)).resolves.toBeNull()
    await expect(verifyKunTokenPayload(c.token)).resolves.toBeNull()
    expect(await verifyKunTokenPayload(foreign.token)).not.toBeNull()
    expect(cookieDeletes).toEqual([])
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
