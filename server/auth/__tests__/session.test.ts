import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'

// 站点会话的签发与解析: 真实 jsonwebtoken, Redis 用内存假件, 库只 mock user 表

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

const { findUniqueMock, userUpdateMock, cookieSetMock, stampMode } = vi.hoisted(
  () => ({
    findUniqueMock: vi.fn(),
    userUpdateMock: vi.fn(),
    cookieSetMock: vi.fn(),
    // 安全戳不一致时是否拒绝 (强制模式); 影子模式只记日志
    stampMode: { enforce: true }
  })
)

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock, update: userUpdateMock } }
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSetMock })
}))
vi.mock('~/server/auth/securityStamp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/auth/securityStamp')>()),
  rejectOnStampMismatch: vi.fn(() => stampMode.enforce)
}))
vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  establishKunSession,
  KUN_BANNED_LOGIN_MESSAGE,
  mintKunSessionToken,
  reissueKunSessionToken,
  resolveKunSiteSession,
  verifyKunTokenWithUser
} from '~/server/auth/session'
import { rejectOnStampMismatch } from '~/server/auth/securityStamp'
import { invalidateUserSession } from '~/server/auth/sessionCache'

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
  security_stamp: null as Date | null,
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
  stampMode.enforce = true
  // 解析会话时按 1/100 抽样清理过期成员: 固定在不抽中的桶, 免得它吃掉注入的 Redis 失败
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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
        'cs',
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
    // 库里的戳为 null: cs 记作 0
    expect(payload.cs).toBe(0)
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

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
    expect(kunLog).toHaveBeenCalledWith(
      'auth.session_revoke_failed',
      { reason: 'user_banned', uid: UID },
      expect.objectContaining({ message: 'redis unavailable' })
    )
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

describe('安全戳', () => {
  const STAMP = new Date(T0 - 60_000)
  const LATER = new Date(T0 + 1000)

  it('令牌的 cs 取自校验凭据时读到的那一行', async () => {
    const { token } = await establish(row({ security_stamp: STAMP }))

    expect((jwt.decode(token) as { cs: number }).cs).toBe(STAMP.getTime())
  })

  it('库里的戳与令牌一致: 已认证', async () => {
    const { token } = await establish(row({ security_stamp: STAMP }))
    findUniqueMock.mockResolvedValue(row({ security_stamp: STAMP }))

    expect((await resolveKunSiteSession(token)).kind).toBe('authenticated')
    expect(rejectOnStampMismatch).not.toHaveBeenCalled()
  })

  it('不带 cs 的存量令牌与库里的 null 都按 0 处理: 上线不踢人', async () => {
    const token = sign({ iss: ISS, aud: AUD, jti: 'old', uid: UID })
    seedSession(token, 'old')

    expect((await resolveKunSiteSession(token)).kind).toBe('authenticated')
  })

  it('签发之后戳刷新过 (改密 / 在途登录读到旧行): 匿名, 删掉这个会话', async () => {
    const { token, jti } = await establish(row({ security_stamp: STAMP }))
    const other = await establish(row({ security_stamp: LATER }))
    findUniqueMock.mockResolvedValue(row({ security_stamp: LATER }))

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
    expect(rejectOnStampMismatch).toHaveBeenCalledWith(
      'site',
      {
        uid: UID,
        jti,
        tokenStamp: STAMP.getTime(),
        userStamp: LATER.getTime()
      },
      { quiet: false }
    )
    expect(redis.has(tokenKey(jti))).toBe(false)
    expect(redis.members(setKey())).toEqual([other.jti])
    // 同一账号带着新戳的会话不受影响
    expect((await resolveKunSiteSession(other.token)).kind).toBe(
      'authenticated'
    )
  })

  it('存量令牌 (无 cs) 遇到已刷新的戳: 同样作废', async () => {
    const token = sign({ iss: ISS, aud: AUD, jti: 'old', uid: UID })
    seedSession(token, 'old')
    findUniqueMock.mockResolvedValue(row({ security_stamp: LATER }))

    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
  })

  it('影子模式: 不一致只记日志, 照常认证, 不删会话', async () => {
    stampMode.enforce = false
    const { token, jti } = await establish(row({ security_stamp: STAMP }))
    findUniqueMock.mockResolvedValue(row({ security_stamp: LATER }))

    expect((await resolveKunSiteSession(token)).kind).toBe('authenticated')
    expect(rejectOnStampMismatch).toHaveBeenCalledTimes(1)
    expect(redis.get(tokenKey(jti))).toBe(token)
  })

  it('鉴权缓存里没有安全戳的旧条目当作未命中, 回源读库', async () => {
    const { token } = await establish()
    await resolveKunSiteSession(token)
    const authKey =
      redis.keys().find((key) => key.startsWith('session:authuser:')) ?? ''
    const cached = JSON.parse(redis.get(authKey) ?? '{}')
    expect(cached.securityStamp).toBe(0)
    delete cached.securityStamp
    redis.put(authKey, JSON.stringify(cached), 600)
    findUniqueMock.mockClear()

    await resolveKunSiteSession(token)

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
  })

  it('重签当前会话: 同一个 jti、认证时刻与到期时刻, 换上新戳, 写回 cookie, 元数据不变', async () => {
    const { token, jti } = await establish(row({ security_stamp: STAMP }), {
      ip: '203.0.113.8',
      userAgent: 'vitest'
    })
    const before = jwt.decode(token) as Record<string, number | string>
    const metadata = redis.get(sessionKey(jti))
    vi.setSystemTime(T0 + 60_000)
    cookieSetMock.mockClear()
    findUniqueMock.mockResolvedValue(row({ security_stamp: STAMP }))

    const session = await resolveKunSiteSession(token)
    if (session.kind !== 'authenticated') {
      throw new Error('expected an authenticated session')
    }
    // 与 finishKunSecurityEvent 的次序一致: 先失效鉴权缓存 (里面还是旧戳), 再重签
    await invalidateUserSession(UID)
    await reissueKunSessionToken(session.payload, LATER)

    const reissued = cookieSetMock.mock.calls[0]?.[1] as string
    const after = jwt.decode(reissued) as Record<string, number | string>
    expect(after).toMatchObject({
      jti,
      uid: UID,
      auth_time: before.auth_time,
      exp: before.exp,
      cs: LATER.getTime()
    })
    expect(redis.get(tokenKey(jti))).toBe(reissued)
    expect(redis.ttl(tokenKey(jti))).toBe(THIRTY_DAYS - 60)
    expect(redis.get(sessionKey(jti))).toBe(metadata)
    expect(cookieSetMock).toHaveBeenCalledWith(
      'kun-galgame-patch-moe-token',
      reissued,
      expect.objectContaining({ maxAge: THIRTY_DAYS - 60 })
    )

    findUniqueMock.mockResolvedValue(row({ security_stamp: LATER }))
    expect((await resolveKunSiteSession(reissued)).kind).toBe('authenticated')
    expect(await resolveKunSiteSession(token)).toEqual({ kind: 'anonymous' })
  })
})
