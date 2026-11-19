import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'

// 站点会话的签发与解析: 真实 jsonwebtoken, Redis 用内存假件, 库只 mock user 表

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

const { findUniqueMock, userUpdateMock, cookieSetMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  cookieSetMock: vi.fn()
}))

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock, update: userUpdateMock } }
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSetMock })
}))

import {
  establishKunSession,
  KUN_BANNED_LOGIN_MESSAGE,
  mintKunSessionToken,
  resolveKunSiteSession,
  verifyKunTokenWithUser
} from '~/server/auth/session'

const SECRET = 'session-test-secret'
const ISS = 'kun-test-iss'
const AUD = 'kun-test-aud'
const UID = 7
const T0 = new Date('2027-01-15T08:00:00.000Z').getTime()
const THIRTY_DAYS = 30 * 24 * 60 * 60

const tokenKey = (jti: string, uid = UID) => `access:token:${uid}:${jti}`
const sessionKey = (jti: string, uid = UID) => `access:session:${uid}:${jti}`
const setKey = (uid = UID) => `access:sessions:${uid}`
const versionKey = (uid = UID) => `session:user:version:${uid}`

const row = (overrides: Record<string, unknown> = {}) => ({
  id: UID,
  name: 'kun',
  role: 1,
  status: 0,
  blocked_tag_ids: [3],
  ...overrides
})

// 等 issueKunSessionToken 里不 await 的清理跑完 (假件的调用都是微任务)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const establish = async (
  subject = row(),
  context = { ip: '', userAgent: '' }
) => {
  const result = await establishKunSession(subject, context)
  await flush()
  const token = cookieSetMock.mock.calls.at(-1)?.[1] as string
  return { result, token, jti: (jwt.decode(token) as { jti: string }).jti }
}

const sign = (
  payload: Record<string, unknown>,
  options: jwt.SignOptions = { expiresIn: '30d' },
  secret = SECRET
) => jwt.sign(payload, secret, options)

const seedSession = (token: string, jti: string, uid = UID) => {
  redis.put(tokenKey(jti, uid), token, THIRTY_DAYS)
  redis.put(
    sessionKey(jti, uid),
    JSON.stringify({
      id: jti,
      userAgent: '',
      ip: '',
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    }),
    THIRTY_DAYS
  )
  redis.putSet(setKey(uid), [jti], THIRTY_DAYS)
}

beforeEach(() => {
  vi.resetAllMocks()
  redis.reset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.stubEnv('JWT_SECRET', SECRET)
  vi.stubEnv('JWT_ISS', ISS)
  vi.stubEnv('JWT_AUD', AUD)
  findUniqueMock.mockResolvedValue(row())
  userUpdateMock.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('establishKunSession', () => {
  it('签发带 auth_time 的令牌, 一次写入 token / 会话元数据 / 版本键, 写 cookie, 记登录时间', async () => {
    const { result, token, jti } = await establish(row(), {
      ip: '203.0.113.8',
      userAgent: 'vitest'
    })

    expect(result).toEqual({ ok: true })
    const payload = jwt.verify(token, SECRET) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(
      [
        'aud',
        'auth_time',
        'exp',
        'iat',
        'iss',
        'jti',
        'name',
        'role',
        'uid'
      ].sort()
    )
    expect(payload).toMatchObject({ iss: ISS, aud: AUD, uid: UID, role: 1 })
    expect(payload.auth_time).toBe(T0 / 1000)
    expect(payload.iat).toBe(T0 / 1000)
    expect(payload.exp).toBe(T0 / 1000 + THIRTY_DAYS)

    expect(redis.get(tokenKey(jti))).toBe(token)
    expect(redis.ttl(tokenKey(jti))).toBe(THIRTY_DAYS)
    expect(JSON.parse(redis.get(sessionKey(jti)) ?? '')).toEqual({
      id: jti,
      userAgent: 'vitest',
      ip: '203.0.113.8',
      createdAt: T0,
      lastActiveAt: T0
    })
    expect(redis.members(setKey())).toEqual([jti])
    // 闸门 B: 版本键随签发轮换, 与 token 在同一次写入里
    const write = redis.calls.find((c) => c.fn === 'setKvsAndAddKvSetMembers')
    expect(JSON.stringify(write?.args)).toContain(versionKey())
    expect(redis.get(versionKey())).toEqual(expect.any(String))

    expect(cookieSetMock).toHaveBeenCalledWith(
      'kun-galgame-patch-moe-token',
      token,
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        maxAge: THIRTY_DAYS
      })
    )
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: UID },
      data: { last_login_time: { set: String(T0) } }
    })
    expect(redis.has(`session:user:last-active:${UID}`)).toBe(true)
  })

  it('封禁的账号不签发、不写 cookie、不记登录时间', async () => {
    const result = await establishKunSession(row({ status: 2 }), {
      ip: '',
      userAgent: ''
    })

    expect(result).toEqual({ ok: false, message: KUN_BANNED_LOGIN_MESSAGE })
    expect(redis.keys()).toEqual([])
    expect(cookieSetMock).not.toHaveBeenCalled()
    expect(userUpdateMock).not.toHaveBeenCalled()
  })

  it('建立的会话能被解析器认出来', async () => {
    const { token } = await establish()

    expect(await resolveKunSiteSession(token)).toMatchObject({
      kind: 'authenticated',
      payload: { uid: UID }
    })
  })
})

describe('resolveKunSiteSession', () => {
  it.each([
    ['空 token', () => ''],
    ['不是 JWT', () => 'garbage'],
    [
      '别的密钥签的',
      () => sign({ iss: ISS, aud: AUD, jti: 'j', uid: UID }, undefined, 'other')
    ],
    ['iss 不对', () => sign({ iss: 'x', aud: AUD, jti: 'j', uid: UID })],
    ['aud 不对', () => sign({ iss: ISS, aud: 'x', jti: 'j', uid: UID })],
    [
      '已过期',
      () => sign({ iss: ISS, aud: AUD, jti: 'j', uid: UID }, { expiresIn: -10 })
    ],
    ['uid 不是数字', () => sign({ iss: ISS, aud: AUD, jti: 'j', uid: '7' })],
    ['没有 jti', () => sign({ iss: ISS, aud: AUD, uid: UID })]
  ])('令牌本身不成立 (%s): 匿名, 不碰 Redis', async (_label, make) => {
    expect(await resolveKunSiteSession(make())).toEqual({ kind: 'anonymous' })
    expect(redis.calls).toEqual([])
  })

  it('Redis 里没有这个会话 (已吊销 / 过期): 匿名', async () => {
    const token = sign({ iss: ISS, aud: AUD, jti: 'j1', uid: UID })

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
  })

  it('Redis 里同一个 jti 存的是另一张令牌: 匿名', async () => {
    const token = sign({ iss: ISS, aud: AUD, jti: 'j1', uid: UID })
    seedSession('another-token', 'j1')

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
  })

  it('会话元数据损坏: 匿名, 并清掉这个会话', async () => {
    const token = sign({ iss: ISS, aud: AUD, jti: 'j1', uid: UID })
    seedSession(token, 'j1')
    redis.put(sessionKey('j1'), '{bad json', THIRTY_DAYS)

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
    expect(redis.has(tokenKey('j1'))).toBe(false)
    expect(redis.has(sessionKey('j1'))).toBe(false)
    expect(redis.members(setKey())).toEqual([])
  })

  it('旧版的单令牌键 access:token:<uid> 不再被认作会话', async () => {
    const token = sign({ iss: ISS, aud: AUD, jti: 'j1', uid: UID })
    redis.put(`access:token:${UID}`, token, THIRTY_DAYS)

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
    expect(redis.has(tokenKey('j1'))).toBe(false)
  })

  it('读会话时 Redis 出错: 不可用, 不清理', async () => {
    const { token, jti } = await establish()
    const error = new Error('redis down')
    redis.failNext('getKvs', error)

    expect(await resolveKunSiteSession(token)).toEqual({
      kind: 'unavailable',
      cause: error
    })
    expect(redis.get(tokenKey(jti))).toBe(token)
  })

  it('读用户时库出错: 不可用, 不吊销', async () => {
    const { token, jti } = await establish()
    const error = new Error('db down')
    findUniqueMock.mockRejectedValue(error)

    expect(await resolveKunSiteSession(token)).toEqual({
      kind: 'unavailable',
      cause: error
    })
    expect(redis.get(tokenKey(jti))).toBe(token)
  })

  it.each([
    ['库里查无此人', null],
    ['已封禁', row({ status: 2 })]
  ])('%s: 匿名, 吊销这个账号的全部会话', async (_label, dbRow) => {
    const { token } = await establish()
    const other = await establish()
    findUniqueMock.mockResolvedValue(dbRow)

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
    expect(redis.has(tokenKey(other.jti))).toBe(false)
    expect(redis.has(setKey())).toBe(false)
  })

  it('封禁时吊销失败也照样匿名 (库给出的是正面证据)', async () => {
    const { token } = await establish()
    findUniqueMock.mockResolvedValue(row({ status: 2 }))
    redis.failNext('getKvSetMembers')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('已认证: 名字与角色取自库, 不采信令牌里的 claim; 域外角色回落为普通用户', async () => {
    const { token } = await establish(row({ role: 4 }))
    findUniqueMock.mockResolvedValue(row({ name: 'renamed', role: 99 }))

    const session = await resolveKunSiteSession(token)

    expect(session).toMatchObject({
      kind: 'authenticated',
      payload: { uid: UID, name: 'renamed', role: 1 },
      user: { id: UID, blocked_tag_ids: [3] }
    })
  })

  it('鉴权缓存命中时不读库; 未命中时读库并写缓存', async () => {
    const { token } = await establish()

    await resolveKunSiteSession(token)
    await resolveKunSiteSession(token)

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
  })

  it('授权一侧把不可用当作未登录', async () => {
    const { token } = await establish()
    redis.failNext('getKvs')

    expect(await verifyKunTokenWithUser(token)).toBeNull()
  })
})

describe('mintKunSessionToken', () => {
  it('为库里的账号签一个可解析的会话, 不写 cookie', async () => {
    const { token, jti } = await mintKunSessionToken(UID)

    expect(redis.get(tokenKey(jti))).toBe(token)
    expect(cookieSetMock).not.toHaveBeenCalled()
    expect((await resolveKunSiteSession(token)).kind).toBe('authenticated')
  })

  it('封禁或不存在的账号直接抛错', async () => {
    findUniqueMock.mockResolvedValue(row({ status: 2 }))
    await expect(mintKunSessionToken(UID)).rejects.toThrow()

    findUniqueMock.mockResolvedValue(null)
    await expect(mintKunSessionToken(UID)).rejects.toThrow()
  })
})
