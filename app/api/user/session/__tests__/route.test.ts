import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { UserState } from '~/types/api/session'

// GET /api/user/session (T60): 401 只表示会话确实无效, Redis 或库不可用时回 503。
// 真实 JWT 与会话缓存跑在内存 Redis 假件上; 用户状态、未读与鉴权读到的 user 行是 mock
const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

const {
  getUserStatusMock,
  touchUserLastActiveTimeMock,
  getUnreadMock,
  findUniqueMock
} = vi.hoisted(() => ({
  getUserStatusMock: vi.fn(),
  touchUserLastActiveTimeMock: vi.fn(),
  getUnreadMock: vi.fn(),
  findUniqueMock: vi.fn()
}))

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock } }
}))
vi.mock('~/app/api/user/status/service', () => ({
  getUserStatus: getUserStatusMock
}))
vi.mock('~/server/auth/sessionActivity', () => ({
  touchUserLastActiveTime: touchUserLastActiveTimeMock,
  updateUserLastLoginTime: vi.fn()
}))
vi.mock('~/app/api/message/unread/service', () => ({
  getUnreadMessageStatus: getUnreadMock
}))

import {
  mintKunSessionToken,
  resolveKunSiteSession
} from '~/server/auth/session'
import { GET } from '~/app/api/user/session/route'

const UID = 7
const OTHER_UID = 8
const T0 = new Date('2027-01-15T08:00:00.000Z').getTime()
const AUTH_COOKIE = 'kun-galgame-patch-moe-token'

const userState = (overrides: Partial<UserState> = {}): UserState => ({
  uid: UID,
  name: 'kun',
  avatar: '',
  bio: '',
  moemoepoint: 0,
  role: 1,
  dailyCheckIn: 0,
  dailyImageLimit: 0,
  dailyUploadLimit: 0,
  enableEmailNotice: true,
  allowPrivateMessage: true,
  blockedTagIds: [],
  enableRedirect: false,
  excludedDomains: [],
  delaySeconds: 0,
  ...overrides
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const login = async (uid = UID) => {
  const { token } = await mintKunSessionToken(uid)
  await flush()
  return token
}

// 会话还在 (没有被吊销)
const alive = async (token: string) =>
  (await resolveKunSiteSession(token)).kind === 'authenticated'

const request = (token?: string) =>
  new NextRequest('http://localhost/api/user/session', {
    headers: token ? { cookie: `${AUTH_COOKIE}=${token}` } : {}
  })

const cacheKey = (uid: number) =>
  `session:user:0:${redis.get(`session:user:version:${uid}`)}:${uid}`

beforeEach(() => {
  redis.reset()
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.stubEnv('JWT_SECRET', 'jwt-test-secret')
  vi.stubEnv('JWT_ISS', 'kun-test-iss')
  vi.stubEnv('JWT_AUD', 'kun-test-aud')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  getUserStatusMock.mockResolvedValue(userState())
  touchUserLastActiveTimeMock.mockResolvedValue(undefined)
  getUnreadMock.mockResolvedValue({
    hasUnreadNotification: true,
    hasUnreadConversation: false
  })
  findUniqueMock.mockImplementation(
    async ({ where }: { where: { id: number } }) => ({
      id: where.id,
      name: 'kun',
      role: 1,
      status: 0,
      blocked_tag_ids: []
    })
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('GET /api/user/session', () => {
  it('returns 200 { user, unread } for a valid token and caches the user state for 10 minutes', async () => {
    const token = await login()

    const response = await GET(request(token))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: userState(),
      unread: { hasUnreadNotification: true, hasUnreadConversation: false }
    })
    expect(getUserStatusMock).toHaveBeenCalledWith(UID)
    expect(touchUserLastActiveTimeMock).toHaveBeenCalledWith(UID)
    expect(getUnreadMock).toHaveBeenCalledWith(UID)
    expect(JSON.parse(redis.get(cacheKey(UID)) ?? 'null')).toEqual(userState())
    expect(redis.ttl(cacheKey(UID))).toBe(600)
  })

  it('returns 401 用户登录失效 without a cookie and without touching Redis', async () => {
    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(await response.json()).toBe('用户登录失效')
    expect(redis.calls).toEqual([])
    expect(getUserStatusMock).not.toHaveBeenCalled()
  })

  it('returns 401 for a token whose session was revoked', async () => {
    const token = await login()
    redis.reset()

    const response = await GET(request(token))

    expect(response.status).toBe(401)
    expect(getUserStatusMock).not.toHaveBeenCalled()
  })

  it('returns 503 when Redis getKvs rejects, keeping the session (T60: was 401)', async () => {
    const token = await login()
    redis.failNext('getKvs')

    const response = await GET(request(token))

    expect(response.status).toBe(503)
    expect(await response.json()).toBe('会话服务暂时不可用')
    expect(getUserStatusMock).not.toHaveBeenCalled()
    expect(await alive(token)).toBe(true)
  })

  it('returns 503 when reading the user row for authentication rejects', async () => {
    const token = await login()
    findUniqueMock.mockRejectedValue(new Error('db down'))

    const response = await GET(request(token))

    expect(response.status).toBe(503)
    expect(redis.callNames()).not.toContain('delKvs')
  })

  it('returns 503 when getUserStatus rejects, without deleting any session (T60: was 401)', async () => {
    const token = await login()
    getUserStatusMock.mockRejectedValue(new Error('db down'))

    const response = await GET(request(token))

    expect(response.status).toBe(503)
    expect(await response.json()).toBe('会话服务暂时不可用')
    expect(redis.callNames()).not.toContain('delKvs')
    expect(await alive(token)).toBe(true)
    expect(touchUserLastActiveTimeMock).not.toHaveBeenCalled()
  })

  it.each(['用户未找到', '用户登录失效'])(
    'returns 401 and deletes every session of the uid when getUserStatus returns %s',
    async (message) => {
      const token = await login()
      const second = await login()
      const other = await login(OTHER_UID)
      const version = redis.get(`session:user:version:${UID}`)
      getUserStatusMock.mockResolvedValue(message)

      const response = await GET(request(token))

      expect(response.status).toBe(401)
      expect(await response.json()).toBe('用户登录失效')
      expect(await alive(token)).toBe(false)
      expect(await alive(second)).toBe(false)
      expect(redis.members(`access:sessions:${UID}`)).toEqual([])
      expect(redis.get(`session:user:version:${UID}`)).not.toBe(version)
      expect(await alive(other)).toBe(true)
      expect(touchUserLastActiveTimeMock).not.toHaveBeenCalled()
    }
  )

  it('still returns 401 when deleting the sessions fails in that branch (T60: the route used to throw)', async () => {
    const token = await login()
    getUserStatusMock.mockResolvedValue('用户登录失效')
    redis.failNext('delKvs', new Error('redis del failed'))

    const response = await GET(request(token))

    expect(response.status).toBe(401)
    expect(await response.json()).toBe('用户登录失效')
  })

  it('serves a session-cache hit without calling getUserStatus or touchUserLastActiveTime', async () => {
    const token = await login()
    const cached = userState({ name: 'cached-kun', blockedTagIds: [3] })
    redis.put(cacheKey(UID), JSON.stringify(cached), 600)

    const response = await GET(request(token))

    expect(response.status).toBe(200)
    expect((await response.json()).user).toEqual(cached)
    expect(getUserStatusMock).not.toHaveBeenCalled()
    expect(touchUserLastActiveTimeMock).not.toHaveBeenCalled()
  })

  it('ignores a cache entry written under an older version (a new login rotates it)', async () => {
    const first = await login()
    redis.put(cacheKey(UID), JSON.stringify(userState({ name: 'stale' })), 600)
    await login()

    const response = await GET(request(first))

    expect((await response.json()).user.name).toBe('kun')
    expect(getUserStatusMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to getUserStatus and skips the cache write when the cache scope cannot be read', async () => {
    const token = await login()
    // 前三次 getKv 是鉴权缓存 (作用域两次 + 条目一次), 第四次才是 UserState 缓存的作用域
    redis.beforeNext('getKv', () => undefined)
    redis.beforeNext('getKv', () => undefined)
    redis.beforeNext('getKv', () => undefined)
    redis.beforeNext('getKv', () => {
      throw new Error('redis down')
    })

    const response = await GET(request(token))

    expect(response.status).toBe(200)
    expect(getUserStatusMock).toHaveBeenCalledWith(UID)
    expect(redis.has(cacheKey(UID))).toBe(false)
  })

  it('degrades unread to all-false when getUnreadMessageStatus rejects', async () => {
    const token = await login()
    getUnreadMock.mockRejectedValue(new Error('unread down'))

    const response = await GET(request(token))

    expect(response.status).toBe(200)
    expect((await response.json()).unread).toEqual({
      hasUnreadNotification: false,
      hasUnreadConversation: false
    })
  })
})
