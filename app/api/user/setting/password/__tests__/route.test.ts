import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { KUN_ROLE } from '~/constants/role'

// 改密码入口的可观察行为。边界用内存态假件, 密码哈希与校验走真实实现
const fakes = await vi.hoisted(async () =>
  (
    await import('~/app/api/user/setting/__tests__/_credentialFakes')
  ).createCredentialFakes()
)

vi.mock('~/prisma/index', () => fakes.modules.prisma)
vi.mock('~/lib/redis', () => fakes.modules.redis)
vi.mock('~/server/auth/attemptBudget', () => fakes.modules.budget)
vi.mock('~/middleware/_verifyHeaderCookie', () => fakes.modules.session)
vi.mock('~/app/api/utils/jwt', () => fakes.modules.jwt)
vi.mock('next/headers', () => fakes.modules.headers)

import { hashPassword, verifyPassword } from '~/server/auth/algorithm'
import {
  jsonRequest,
  makeUser
} from '~/app/api/user/setting/__tests__/_credentialFakes'
import { POST } from '~/app/api/user/setting/password/route'

const { budget, db, session } = fakes
const UID = 7
const OLD_PASSWORD = 'oldpass123'
const NEW_PASSWORD = 'newpass456'
const WRONG_PASSWORD = 'wrongpass789'
const AUTH_COOKIE = 'kun-galgame-patch-moe-token'
// 慢机器上 argon2 (纯 JS) 单次可达数百毫秒, 多次校验的用例放宽时限
const ARGON2_HEAVY_TIMEOUT = 60_000

let oldHash = ''

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    jsonRequest('/api/user/setting/password', body, {
      'x-real-ip': '203.0.113.8',
      ...headers
    }) as unknown as Parameters<typeof POST>[0]
  )

const read = async (response: Response) => response.json()

beforeAll(async () => {
  oldHash = await hashPassword(OLD_PASSWORD)
})

beforeEach(() => {
  fakes.reset()
  db.insertUser(makeUser({ id: UID, password: oldHash }))
  session.signIn(UID, KUN_ROLE.USER)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/user/setting/password', () => {
  it('rejects a malformed old password without reading the DB', async () => {
    const response = await post({
      oldPassword: 'short',
      newPassword: NEW_PASSWORD
    })

    expect(await read(response)).toBe(
      '旧密码格式非法, 密码的长度为 6 到 1007 位，必须包含至少一个英文字符和一个数字，可以选择性的包含 @!#$%^&*()_-+=\\/ 等特殊字符'
    )
    expect(db.queries).toEqual([])
  })

  it('rejects a malformed new password without reading the DB', async () => {
    const response = await post({
      oldPassword: OLD_PASSWORD,
      newPassword: 'abcdefgh'
    })

    expect(await read(response)).toBe(
      '新密码格式非法, 密码的长度为 6 到 1007 位，必须包含至少一个英文字符和一个数字，可以选择性的包含 @!#$%^&*()_-+=\\/ 等特殊字符'
    )
    expect(db.queries).toEqual([])
  })

  it('parses the body before checking the session', async () => {
    session.signOut()

    const invalid = await post({
      oldPassword: 'short',
      newPassword: NEW_PASSWORD
    })
    const valid = await post({
      oldPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD
    })

    expect(await read(invalid)).toMatch(/^旧密码格式非法/)
    expect(await read(valid)).toBe('用户未登录')
    expect(db.queries).toEqual([])
  })

  it('requires a client IP header before reading the DB', async () => {
    const response = await POST(
      jsonRequest('/api/user/setting/password', {
        oldPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD
      }) as unknown as Parameters<typeof POST>[0]
    )

    expect(await read(response)).toBe('读取请求头失败')
    expect(db.queries).toEqual([])
  })

  it('rejects a wrong old password and leaves the account untouched', async () => {
    const response = await post({
      oldPassword: WRONG_PASSWORD,
      newPassword: NEW_PASSWORD
    })

    expect(await read(response)).toBe('当前密码输入错误')
    expect(db.user(UID)?.password).toBe(oldHash)
    expect(session.revokedUids).toEqual([])
    expect(session.deletedCookies).toEqual([])
  })

  it('rejects a session whose user row is gone without writing anything', async () => {
    db.reset()

    const response = await post({
      oldPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD
    })

    expect(await read(response)).toBe('用户不存在')
    // 没有任何写尝试
    expect(
      db.queries.filter((query) => !query.endsWith('.findUnique'))
    ).toEqual([])
    expect(session.revokedUids).toEqual([])
    expect(session.deletedCookies).toEqual([])
  })

  it(
    'stores a hash of the new password, then revokes every session and the auth cookie',
    async () => {
      let hashAtRevoke = ''
      session.onRevoke((uid) => {
        hashAtRevoke = db.user(uid)?.password ?? ''
      })

      const response = await post({
        oldPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD
      })

      expect(await read(response)).toEqual({})
      const stored = db.user(UID)?.password ?? ''
      expect(stored).not.toBe(oldHash)
      expect(await verifyPassword(NEW_PASSWORD, stored)).toBe(true)
      expect(await verifyPassword(OLD_PASSWORD, stored)).toBe(false)
      expect(session.revokedUids).toEqual([UID])
      // 吊销发生在新哈希落库之后
      expect(hashAtRevoke).toBe(stored)
      expect(session.deletedCookies).toEqual([AUTH_COOKIE])
    },
    ARGON2_HEAVY_TIMEOUT
  )

  it(
    'locks after ten wrong old passwords, even for the right one, and changes nothing',
    async () => {
      for (let i = 0; i < 10; i++) {
        const response = await post(
          { oldPassword: `${WRONG_PASSWORD}${i}`, newPassword: NEW_PASSWORD },
          // 换着 IP 来: 每账号 10 次的上限与 IP 无关
          { 'x-real-ip': `203.0.113.${i}` }
        )
        expect(await read(response)).toBe('当前密码输入错误')
      }

      const response = await post(
        { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
        { 'x-real-ip': '203.0.113.99' }
      )

      expect(await read(response)).toBe('密码尝试次数过多, 请 15 分钟后再试')
      expect(db.user(UID)?.password).toBe(oldHash)
      expect(session.revokedUids).toEqual([])
    },
    ARGON2_HEAVY_TIMEOUT
  )

  it(
    'locks one IP after five wrong old passwords',
    async () => {
      for (let i = 0; i < 5; i++) {
        await post({
          oldPassword: `${WRONG_PASSWORD}${i}`,
          newPassword: NEW_PASSWORD
        })
      }

      const sameIp = await post({
        oldPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD
      })
      expect(await read(sameIp)).toBe('密码尝试次数过多, 请 15 分钟后再试')

      const otherIp = await post(
        { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
        { 'x-real-ip': '198.51.100.7' }
      )
      expect(await read(otherIp)).toEqual({})
    },
    ARGON2_HEAVY_TIMEOUT
  )

  it(
    'forgives earlier wrong guesses once the right password arrives',
    async () => {
      for (let i = 0; i < 3; i++) {
        await post({
          oldPassword: `${WRONG_PASSWORD}${i}`,
          newPassword: NEW_PASSWORD
        })
      }
      expect(budget.counts.get(`auth:stepup:pw:uid:${UID}`)).toBe(3)

      const response = await post({
        oldPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD
      })

      expect(await read(response)).toEqual({})
      expect([...budget.counts.keys()]).toEqual([])
    },
    ARGON2_HEAVY_TIMEOUT
  )

  it('fails closed, before reading the credential, when attempts cannot be counted', async () => {
    budget.failNext()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await post({
      oldPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD
    })

    expect(await read(response)).toBe('验证服务暂不可用, 请稍后重试')
    expect(db.queries).toEqual([])
    expect(db.user(UID)?.password).toBe(oldHash)
  })

  it('keeps the wrong guesses of one user from locking another user on the same IP', async () => {
    db.insertUser(
      makeUser({
        id: 8,
        name: 'other',
        email: 'o@example.com',
        password: oldHash
      })
    )
    for (let i = 0; i < 5; i++) {
      await post({
        oldPassword: `${WRONG_PASSWORD}${i}`,
        newPassword: NEW_PASSWORD
      })
    }

    session.signIn(8, KUN_ROLE.USER)
    const response = await post({
      oldPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD
    })

    expect(await read(response)).toEqual({})
  })
})
