import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Characterization of POST /api/user/status/logout. Real auth chain (verifyHeaderCookie →
// server/viewer → jwt) over the in-memory Redis fake; the user row comes from a tiny prisma fake.

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

const { cookieDeletes } = vi.hoisted(() => ({
  cookieDeletes: [] as string[]
}))

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findUnique: async (args: { where: { id: number } }) => ({
        id: args.where.id,
        name: 'kun',
        role: 1,
        status: 0,
        blocked_tag_ids: []
      })
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
import { POST } from '~/app/api/user/status/logout/route'

// 会话仍然有效 (没被吊销): 经唯一的解析器判定
const verifyKunTokenPayload = async (token: string) => {
  const session = await resolveKunSiteSession(token)
  return session.kind === 'authenticated' ? session.payload : null
}

const UID = 7
const AUTH_COOKIE = 'kun-galgame-patch-moe-token'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const login = async () => {
  const token = (await mintKunSessionToken(UID)).token
  await flush()
  return token
}

const request = (token?: string) =>
  new NextRequest('http://localhost/api/user/status/logout', {
    method: 'POST',
    headers: token ? { cookie: `${AUTH_COOKIE}=${token}` } : {}
  })

beforeEach(() => {
  redis.reset()
  cookieDeletes.length = 0
  vi.stubEnv('JWT_SECRET', 'jwt-test-secret')
  vi.stubEnv('JWT_ISS', 'kun-test-iss')
  vi.stubEnv('JWT_AUD', 'kun-test-aud')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/user/status/logout', () => {
  it('deletes only the current session and the auth cookie', async () => {
    const current = await login()
    const other = await login()
    const version = redis.get(`session:user:version:${UID}`)

    const response = await POST(request(current))

    expect(await response.json()).toEqual({ message: '退出登录成功' })
    expect(cookieDeletes).toEqual([AUTH_COOKIE])
    await expect(verifyKunTokenPayload(current)).resolves.toBeNull()
    expect(await verifyKunTokenPayload(other)).not.toBeNull()
    expect(redis.members(`access:sessions:${UID}`)).toHaveLength(1)
    // the per-user session-cache version is not rotated by a single-session logout
    expect(redis.get(`session:user:version:${UID}`)).toBe(version)
  })

  it('returns 用户未登录 without a session and leaves the cookie alone', async () => {
    const response = await POST(request())

    expect(await response.json()).toBe('用户未登录')
    expect(cookieDeletes).toEqual([])
  })

  it('[current] a cookie whose session is already revoked gets 用户未登录 and is not cleared', async () => {
    const current = await login()
    await POST(request(current))
    cookieDeletes.length = 0

    const response = await POST(request(current))

    expect(await response.json()).toBe('用户未登录')
    expect(cookieDeletes).toEqual([])
  })
})
