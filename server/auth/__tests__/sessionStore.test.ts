import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'

// 登录会话在 Redis 里的存储 (server/auth/session.ts): 签发、续期、清理、列表与吊销。
// 由片 C 之前 app/api/utils/jwt.ts 的特征测试改写而来; 真实 jsonwebtoken, Redis 用内存假件,
// 只假 Date, 好让签发里不 await 的清理用一次真实的宏任务排空。库里每个 uid 都是正常用户
const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => ({
        id: where.id,
        name: 'kun',
        role: 1,
        status: 0,
        blocked_tag_ids: []
      })
    }
  }
}))

import {
  deleteKunToken,
  deleteKunTokenSession,
  deleteOtherKunTokenSessions,
  getKunLoginSessions,
  mintKunSessionToken,
  resolveKunSiteSession
} from '~/server/auth/session'

// 会话仍然有效时返回令牌载荷: 经唯一的解析器判定
const verifyKunTokenPayload = async (token: string) => {
  const session = await resolveKunSiteSession(token)
  return session.kind === 'authenticated' ? session.payload : null
}

const SECRET = 'jwt-test-secret'
const ISS = 'kun-test-iss'
const AUD = 'kun-test-aud'
const UID = 7
const OTHER_UID = 8
const T0 = new Date('2027-01-15T08:00:00.000Z').getTime()
const THIRTY_DAYS = 30 * 24 * 60 * 60
const FIVE_MINUTES_MS = 5 * 60 * 1000
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const tokenKey = (uid: number, jti: string) => `access:token:${uid}:${jti}`
const sessionKey = (uid: number, jti: string) => `access:session:${uid}:${jti}`
const setKey = (uid: number) => `access:sessions:${uid}`
const legacyKey = (uid: number) => `access:token:${uid}`
const versionKey = (uid: number) => `session:user:version:${uid}`
const touchLockKey = (uid: number, jti: string) =>
  `access:session-touch:${uid}:${jti}`

// Drains the issuance's `void pruneStaleLoginSessions(...)` (all fake calls are microtasks)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const login = async (
  uid = UID,
  context?: { userAgent?: string; ip?: string }
) => {
  const { token } = await mintKunSessionToken(uid, context)
  await flush()
  const { jti } = jwt.decode(token) as { jti: string }
  return { token, jti }
}

const sign = (
  payload: Record<string, unknown>,
  options: jwt.SignOptions = { expiresIn: '30d' },
  secret = SECRET
) => jwt.sign(payload, secret, options)

const basePayload = (overrides: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: AUD,
  jti: 'jti-x',
  uid: UID,
  name: 'kun',
  role: 1,
  ...overrides
})

const metadata = (jti: string, at = T0) =>
  JSON.stringify({
    id: jti,
    userAgent: '',
    ip: '',
    createdAt: at,
    lastActiveAt: at
  })

const readMetadata = (uid: number, jti: string) =>
  JSON.parse(redis.get(sessionKey(uid, jti)) ?? 'null')

// every access:* key carries the uid as its third segment
const uidKeys = (uid: number) =>
  redis
    .keys()
    .filter(
      (key) => key.startsWith('access:') && key.split(':')[2] === String(uid)
    )

beforeEach(() => {
  redis.reset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.stubEnv('JWT_SECRET', SECRET)
  vi.stubEnv('JWT_ISS', ISS)
  vi.stubEnv('JWT_AUD', AUD)
  // maybePruneStaleLoginSessions samples Math.random; 0.5 skips the 1-in-100 prune
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('签发 (mintKunSessionToken)', () => {
  it('signs exactly iss/aud/jti/uid/name/role/auth_time plus iat/exp, 30 days apart', async () => {
    const { token } = await mintKunSessionToken(UID)
    const decoded = jwt.verify(token, SECRET) as Record<string, unknown>

    expect(Object.keys(decoded).sort()).toEqual([
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
    ])
    expect(decoded).toMatchObject({
      iss: ISS,
      aud: AUD,
      uid: UID,
      name: 'kun',
      role: 1,
      iat: T0 / 1000,
      auth_time: T0 / 1000
    })
    expect(decoded.jti).toMatch(UUID_RE)
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(THIRTY_DAYS)
  })

  it('writes token, metadata and set member with a 30-day TTL; truncates userAgent to 1000 and ip to 100', async () => {
    const { token, jti } = await login(UID, {
      userAgent: 'u'.repeat(1500),
      ip: '1'.repeat(150)
    })

    expect(redis.get(tokenKey(UID, jti))).toBe(token)
    expect(redis.ttl(tokenKey(UID, jti))).toBe(THIRTY_DAYS)
    expect(readMetadata(UID, jti)).toEqual({
      id: jti,
      userAgent: 'u'.repeat(1000),
      ip: '1'.repeat(100),
      createdAt: T0,
      lastActiveAt: T0
    })
    expect(redis.ttl(sessionKey(UID, jti))).toBe(THIRTY_DAYS)
    expect(redis.members(setKey(UID))).toEqual([jti])
    expect(redis.ttl(setKey(UID))).toBe(THIRTY_DAYS)
    expect(redis.keys()).toEqual(
      [
        setKey(UID),
        sessionKey(UID, jti),
        tokenKey(UID, jti),
        versionKey(UID)
      ].sort()
    )
  })

  it('stores empty userAgent / ip when no context is given', async () => {
    const { jti } = await login(UID)

    expect(readMetadata(UID, jti)).toMatchObject({ userAgent: '', ip: '' })
  })

  it('rotates the session-cache version key (no TTL) in the same write as the session', async () => {
    redis.put(versionKey(UID), 'v-old')

    await login(UID)

    expect(redis.get(versionKey(UID))).not.toBe('v-old')
    expect(redis.get(versionKey(UID))).toMatch(UUID_RE)
    expect(redis.ttl(versionKey(UID))).toBe(-1)
    expect(redis.calls[0].fn).toBe('setKvsAndAddKvSetMembers')
    const [values] = redis.calls[0].args as [{ key: string }[]]
    expect(values.map(({ key }) => key)).toContain(versionKey(UID))
  })

  it('prunes set members whose token key is gone and keeps live ones', async () => {
    const first = await login(UID)
    redis.putSet(setKey(UID), [first.jti, 'ghost'], THIRTY_DAYS)
    redis.put(sessionKey(UID, 'ghost'), metadata('ghost'))

    const second = await login(UID)

    expect(redis.members(setKey(UID))).toEqual([first.jti, second.jti].sort())
    expect(redis.has(sessionKey(UID, 'ghost'))).toBe(false)
  })

  it('extends a shorter set TTL back to 30 days', async () => {
    redis.putSet(setKey(UID), ['ghost'], 60)

    await login(UID)

    expect(redis.ttl(setKey(UID))).toBe(THIRTY_DAYS)
  })
})

describe('解析 (resolveKunSiteSession)', () => {
  it('returns null for an empty token without touching Redis', async () => {
    await expect(verifyKunTokenPayload('')).resolves.toBeNull()
    expect(redis.calls).toEqual([])
  })

  // Each token is seeded in Redis exactly as a live session would be, so only the
  // JWT-level check stands between it and success
  it.each([
    [
      'bad signature',
      () => sign(basePayload(), { expiresIn: '30d' }, 'other-secret')
    ],
    ['wrong issuer', () => sign(basePayload({ iss: 'evil' }))],
    ['wrong audience', () => sign(basePayload({ aud: 'evil' }))],
    ['expired', () => sign({ ...basePayload(), exp: T0 / 1000 - 1 }, {})],
    ['uid not a number', () => sign(basePayload({ uid: String(UID) }))],
    ['jti not a string', () => sign(basePayload({ jti: 42 }))]
  ])('rejects a token with %s before reading Redis', async (_, make) => {
    const token = make()
    const { jti } = jwt.decode(token) as { jti: string | number }
    redis.put(tokenKey(UID, String(jti)), token)
    redis.put(sessionKey(UID, String(jti)), metadata(String(jti)))

    await expect(verifyKunTokenPayload(token)).resolves.toBeNull()
    expect(redis.calls).toEqual([])
    expect(redis.get(tokenKey(UID, String(jti)))).toBe(token)
  })

  it('returns null when the token is not in Redis', async () => {
    await expect(verifyKunTokenPayload(sign(basePayload()))).resolves.toBeNull()
  })

  it('returns null when Redis holds a different token for the jti, and cleans nothing', async () => {
    const token = sign(basePayload())
    redis.put(tokenKey(UID, 'jti-x'), 'another-token')
    redis.put(sessionKey(UID, 'jti-x'), metadata('jti-x'))

    await expect(verifyKunTokenPayload(token)).resolves.toBeNull()
    // 片 C 删掉了旧版单令牌键的回落: 对不上就结束, 不再多读一次 access:token:<uid>
    expect(redis.callNames()).toEqual(['getKvs'])
    expect(redis.get(tokenKey(UID, 'jti-x'))).toBe('another-token')
    expect(redis.has(sessionKey(UID, 'jti-x'))).toBe(true)
  })

  it.each([
    ['missing', null],
    ['not JSON', 'not-json'],
    [
      'for another id',
      JSON.stringify({
        id: 'other',
        userAgent: '',
        ip: '',
        createdAt: T0,
        lastActiveAt: T0
      })
    ],
    [
      'with a non-numeric createdAt',
      JSON.stringify({ id: 'jti-x', createdAt: 'x', lastActiveAt: T0 })
    ]
  ])(
    'returns null and drops both keys and the set member when metadata is %s',
    async (_, value) => {
      const token = sign(basePayload())
      redis.put(tokenKey(UID, 'jti-x'), token)
      if (value !== null) {
        redis.put(sessionKey(UID, 'jti-x'), value)
      }
      redis.putSet(setKey(UID), ['jti-x', 'jti-y'])

      await expect(verifyKunTokenPayload(token)).resolves.toBeNull()
      expect(redis.has(tokenKey(UID, 'jti-x'))).toBe(false)
      expect(redis.has(sessionKey(UID, 'jti-x'))).toBe(false)
      expect(redis.members(setKey(UID))).toEqual(['jti-y'])
    }
  )

  it('still returns null when that cleanup fails', async () => {
    const token = sign(basePayload())
    redis.put(tokenKey(UID, 'jti-x'), token)
    redis.failNext('delKvsAndRemoveKvSetMembers')

    await expect(verifyKunTokenPayload(token)).resolves.toBeNull()
    expect(redis.get(tokenKey(UID, 'jti-x'))).toBe(token)
  })

  it('returns the decoded payload for a live session', async () => {
    const { token } = await login(UID)

    await expect(verifyKunTokenPayload(token)).resolves.toEqual(
      jwt.decode(token)
    )
  })

  it('does not touch lastActiveAt within 5 minutes', async () => {
    const { token, jti } = await login(UID)
    redis.calls.length = 0
    vi.setSystemTime(T0 + FIVE_MINUTES_MS - 1)

    expect(await verifyKunTokenPayload(token)).not.toBeNull()
    expect(readMetadata(UID, jti).lastActiveAt).toBe(T0)
    // 之后只有鉴权缓存的读写 (作用域、条目、写回), 不续期会话
    expect(redis.callNames()).toEqual([
      'getKvs',
      'getKv',
      'getKv',
      'getKv',
      'setKv'
    ])
  })

  it('touches lastActiveAt once 5 minutes have passed; metadata TTL becomes the JWT remaining lifetime, token key keeps its own', async () => {
    // 签发恒为 30 天; 这里直接签一张 1 天的令牌并照签发的形状写进 Redis
    const jti = 'short-lived'
    const token = sign(basePayload({ jti }), { expiresIn: '1d' })
    redis.put(tokenKey(UID, jti), token, THIRTY_DAYS)
    redis.put(
      sessionKey(UID, jti),
      JSON.stringify({
        id: jti,
        userAgent: 'ua',
        ip: 'ip',
        createdAt: T0,
        lastActiveAt: T0
      }),
      THIRTY_DAYS
    )
    redis.putSet(setKey(UID), [jti], THIRTY_DAYS)
    redis.calls.length = 0
    vi.setSystemTime(T0 + FIVE_MINUTES_MS)

    expect(await verifyKunTokenPayload(token)).not.toBeNull()
    expect(readMetadata(UID, jti)).toEqual({
      id: jti,
      userAgent: 'ua',
      ip: 'ip',
      createdAt: T0,
      lastActiveAt: T0 + FIVE_MINUTES_MS
    })
    expect(redis.ttl(sessionKey(UID, jti))).toBe(24 * 60 * 60 - 300)
    expect(redis.ttl(tokenKey(UID, jti))).toBe(THIRTY_DAYS - 300)
    // set TTL (30d - 5min left) is not below the new TTL, so it is not shortened
    expect(redis.ttl(setKey(UID))).toBe(THIRTY_DAYS - 300)
    expect(redis.has(touchLockKey(UID, jti))).toBe(false)
    expect(redis.callNames().slice(0, 5)).toEqual([
      'getKvs',
      'acquireKvLock',
      'getKv',
      'setKvAndExpireKvIfTtlLessThan',
      'releaseKvLock'
    ])
  })

  it('skips the touch while another request holds the touch lock', async () => {
    const { token, jti } = await login(UID)
    vi.setSystemTime(T0 + FIVE_MINUTES_MS)
    redis.put(touchLockKey(UID, jti), 'someone-else', 10)

    expect(await verifyKunTokenPayload(token)).not.toBeNull()
    expect(readMetadata(UID, jti).lastActiveAt).toBe(T0)
    expect(redis.get(touchLockKey(UID, jti))).toBe('someone-else')
  })

  it('still returns the payload when the touch write fails, and releases the lock', async () => {
    const { token, jti } = await login(UID)
    vi.setSystemTime(T0 + FIVE_MINUTES_MS)
    redis.failNext('setKvAndExpireKvIfTtlLessThan')

    expect(await verifyKunTokenPayload(token)).not.toBeNull()
    expect(readMetadata(UID, jti).lastActiveAt).toBe(T0)
    expect(redis.has(touchLockKey(UID, jti))).toBe(false)
  })

  it('prunes stale set members on a 1-in-100 sample, at most once per hour', async () => {
    const { token, jti } = await login(UID)
    redis.putSet(setKey(UID), [jti, 'ghost'], THIRTY_DAYS)
    vi.mocked(Math.random).mockReturnValue(0)

    expect(await verifyKunTokenPayload(token)).not.toBeNull()
    expect(redis.members(setKey(UID))).toEqual([jti])
    expect(redis.ttl(`access:session-prune:${UID}`)).toBe(60 * 60)

    redis.putSet(setKey(UID), [jti, 'ghost'], THIRTY_DAYS)
    expect(await verifyKunTokenPayload(token)).not.toBeNull()
    expect(redis.members(setKey(UID))).toEqual([jti, 'ghost'].sort())
  })

  it('旧版的单令牌键不再被认作会话, 也不再迁移 (片 C 删掉了这条分支)', async () => {
    const token = sign(basePayload({ jti: 'legacy' }), { expiresIn: '10d' })
    redis.put(legacyKey(UID), token)

    await expect(verifyKunTokenPayload(token)).resolves.toBeNull()
    expect(redis.has(tokenKey(UID, 'legacy'))).toBe(false)
    expect(redis.get(legacyKey(UID))).toBe(token)
    expect(redis.callNames()).toEqual(['getKvs'])
  })

  it('rejects a legacy key holding a different token and leaves it alone', async () => {
    const token = sign(basePayload({ jti: 'legacy' }))
    redis.put(legacyKey(UID), 'other-token')

    await expect(verifyKunTokenPayload(token)).resolves.toBeNull()
    expect(redis.get(legacyKey(UID))).toBe('other-token')
    expect(redis.has(tokenKey(UID, 'legacy'))).toBe(false)
  })

  it('never throws when Redis rejects: unavailable, which authorization treats as logged out', async () => {
    const { token } = await login(UID)
    const error = new Error('redis down')
    redis.failNext('getKvs', error)

    await expect(resolveKunSiteSession(token)).resolves.toEqual({
      kind: 'unavailable',
      cause: error
    })
  })
})

describe('deleteKunToken', () => {
  it('deletes every listed session and the set, and rotates the version key; the dead legacy slot is left to expire', async () => {
    const a = await login(UID)
    const b = await login(UID)
    const other = await login(OTHER_UID)
    redis.put(legacyKey(UID), 'legacy-token')
    const version = redis.get(versionKey(UID))

    await deleteKunToken(UID)

    expect(uidKeys(UID)).toEqual([legacyKey(UID)])
    expect(redis.get(versionKey(UID))).not.toBe(version)
    expect(redis.get(versionKey(UID))).toMatch(UUID_RE)
    await expect(verifyKunTokenPayload(a.token)).resolves.toBeNull()
    await expect(verifyKunTokenPayload(b.token)).resolves.toBeNull()
    expect(await verifyKunTokenPayload(other.token)).not.toBeNull()
    expect(redis.members(setKey(OTHER_UID))).toEqual([other.jti])
  })

  it('[current: X07-06 orphan] a session written between the SMEMBERS read and the DEL survives outside the set', async () => {
    const before = await login(UID)
    let late = { token: '', jti: '' }
    redis.beforeNext('delKvs', async () => {
      late = await login(UID)
    })

    await deleteKunToken(UID)

    await expect(verifyKunTokenPayload(before.token)).resolves.toBeNull()
    // the late session's keys were not in the SMEMBERS snapshot, its set member went with the set
    expect(await verifyKunTokenPayload(late.token)).not.toBeNull()
    expect(redis.members(setKey(UID))).toEqual([])
    await expect(getKunLoginSessions(UID, late.jti)).resolves.toEqual([])

    // ...so neither the session list nor a second revoke-all can reach it
    await deleteKunToken(UID)
    expect(await verifyKunTokenPayload(late.token)).not.toBeNull()
    expect(redis.ttl(tokenKey(UID, late.jti))).toBe(THIRTY_DAYS)
  })

  it('rejects and deletes nothing when the set cannot be read', async () => {
    const a = await login(UID)
    const version = redis.get(versionKey(UID))
    redis.failNext('getKvSetMembers')

    await expect(deleteKunToken(UID)).rejects.toThrow('redis unavailable')
    expect(await verifyKunTokenPayload(a.token)).not.toBeNull()
    expect(redis.get(versionKey(UID))).toBe(version)
  })
})

describe('deleteKunTokenSession', () => {
  it('returns false and leaves stale traces alone when the token key is absent', async () => {
    redis.putSet(setKey(UID), ['ghost'])
    redis.put(sessionKey(UID, 'ghost'), metadata('ghost'))

    await expect(deleteKunTokenSession(UID, 'ghost')).resolves.toBe(false)
    expect(redis.members(setKey(UID))).toEqual(['ghost'])
    expect(redis.has(sessionKey(UID, 'ghost'))).toBe(true)
  })

  it('deletes one session and its set member; other sessions and the version key stay', async () => {
    const a = await login(UID)
    const b = await login(UID)
    const version = redis.get(versionKey(UID))

    await expect(deleteKunTokenSession(UID, a.jti)).resolves.toBe(true)
    await expect(verifyKunTokenPayload(a.token)).resolves.toBeNull()
    expect(redis.has(sessionKey(UID, a.jti))).toBe(false)
    expect(await verifyKunTokenPayload(b.token)).not.toBeNull()
    expect(redis.members(setKey(UID))).toEqual([b.jti])
    expect(redis.get(versionKey(UID))).toBe(version)
  })
})

describe('deleteOtherKunTokenSessions', () => {
  it('revokes other live sessions, prunes stale members, keeps the current one, counts only live others', async () => {
    const current = await login(UID)
    const b = await login(UID)
    const c = await login(UID)
    redis.putSet(setKey(UID), [current.jti, b.jti, c.jti, 'ghost'], THIRTY_DAYS)

    await expect(deleteOtherKunTokenSessions(UID, current.jti)).resolves.toBe(2)
    expect(await verifyKunTokenPayload(current.token)).not.toBeNull()
    await expect(verifyKunTokenPayload(b.token)).resolves.toBeNull()
    await expect(verifyKunTokenPayload(c.token)).resolves.toBeNull()
    expect(redis.members(setKey(UID))).toEqual([current.jti])
  })

  it('returns 0 with nothing else live but still prunes stale members', async () => {
    const current = await login(UID)
    redis.putSet(setKey(UID), [current.jti, 'ghost'], THIRTY_DAYS)

    await expect(deleteOtherKunTokenSessions(UID, current.jti)).resolves.toBe(0)
    expect(redis.members(setKey(UID))).toEqual([current.jti])
    expect(await verifyKunTokenPayload(current.token)).not.toBeNull()
  })

  it('returns 0 for a user with no sessions', async () => {
    await expect(deleteOtherKunTokenSessions(UID, 'any')).resolves.toBe(0)
    expect(redis.callNames()).toEqual(['getKvSetMembers'])
  })

  it('treats a current jti whose token is gone as stale (removed, not counted)', async () => {
    const b = await login(UID)
    redis.putSet(setKey(UID), ['gone', b.jti], THIRTY_DAYS)

    await expect(deleteOtherKunTokenSessions(UID, 'gone')).resolves.toBe(1)
    expect(redis.members(setKey(UID))).toEqual([])
  })
})

describe('getKunLoginSessions', () => {
  it('lists live sessions most recently active first, flagging the current one', async () => {
    const a = await login(UID, { userAgent: 'A', ip: '1.1.1.1' })
    vi.setSystemTime(T0 + 60_000)
    const b = await login(UID, { userAgent: 'B', ip: '2.2.2.2' })
    vi.setSystemTime(T0 + 120_000)
    const c = await login(UID, { userAgent: 'C', ip: '3.3.3.3' })

    await expect(getKunLoginSessions(UID, b.jti)).resolves.toEqual([
      {
        id: c.jti,
        userAgent: 'C',
        ip: '3.3.3.3',
        createdAt: T0 + 120_000,
        lastActiveAt: T0 + 120_000,
        isCurrent: false
      },
      {
        id: b.jti,
        userAgent: 'B',
        ip: '2.2.2.2',
        createdAt: T0 + 60_000,
        lastActiveAt: T0 + 60_000,
        isCurrent: true
      },
      {
        id: a.jti,
        userAgent: 'A',
        ip: '1.1.1.1',
        createdAt: T0,
        lastActiveAt: T0,
        isCurrent: false
      }
    ])
  })

  it('prunes members with no token, no metadata, or metadata for another id', async () => {
    const live = await login(UID)
    redis.put(tokenKey(UID, 'no-meta'), 'tok')
    redis.put(tokenKey(UID, 'mismatch'), 'tok')
    redis.put(sessionKey(UID, 'mismatch'), metadata('someone-else'))
    redis.put(sessionKey(UID, 'no-token'), metadata('no-token'))
    redis.putSet(
      setKey(UID),
      [live.jti, 'no-meta', 'mismatch', 'no-token'],
      THIRTY_DAYS
    )

    const sessions = await getKunLoginSessions(UID, live.jti)

    expect(sessions.map((session) => session.id)).toEqual([live.jti])
    expect(redis.members(setKey(UID))).toEqual([live.jti])
    for (const jti of ['no-meta', 'mismatch', 'no-token']) {
      expect(redis.has(tokenKey(UID, jti))).toBe(false)
      expect(redis.has(sessionKey(UID, jti))).toBe(false)
    }
  })

  it('returns [] for a user with no sessions', async () => {
    await expect(getKunLoginSessions(UID, 'any')).resolves.toEqual([])
    expect(redis.callNames()).toEqual(['getKvSetMembers'])
  })
})
