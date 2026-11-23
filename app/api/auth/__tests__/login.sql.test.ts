import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dataStatements,
  expectLowerEquals
} from '~/prisma/__tests__/support/sqlShape'

// 登录按用户名或邮箱找人发出的 SQL, 不连库: 按种类只查一列 (server/identity/lookup.ts 的
// findUserForLogin), 条件是走 lower() 唯一索引的 lower(列) = lower($1::text), 输入原样绑定。
// 这条语句确实走索引由 server/identity/__tests__/userIdentifier.db.test.ts 在真库上核对

const { recorder, parsePostMock } = await vi.hoisted(async () => ({
  recorder: (
    await import('~/prisma/__tests__/support/sqlRecorder')
  ).createSqlRecorder(),
  parsePostMock: vi.fn()
}))

vi.mock('~/prisma/index', () => recorder.module)

vi.mock('next/headers', () => ({
  cookies: async () => ({ set: vi.fn() })
}))

vi.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePostBody: parsePostMock
}))

vi.mock('~/app/api/utils/algorithm', () => ({
  DUMMY_PASSWORD_HASH: 'dummy',
  hashPassword: vi.fn(),
  needsPasswordRehash: () => false,
  verifyPassword: async () => false
}))

vi.mock('~/server/auth/session', () => ({
  establishKunSession: vi.fn(),
  generateKunStatelessToken: vi.fn(),
  KUN_BANNED_LOGIN_MESSAGE: 'banned'
}))

vi.mock('~/server/auth/cookieOptions', () => ({
  kunCookieOptions: (maxAge: number) => ({ maxAge })
}))

vi.mock('~/app/api/utils/verifyKunCaptcha', () => ({
  checkKunCaptchaExist: async () => true
}))

vi.mock('~/app/api/user/status/service', () => ({
  getUserStatus: vi.fn()
}))

vi.mock('~/app/api/utils/getRemoteIp', () => ({
  getRemoteIp: () => '203.0.113.8'
}))

vi.mock('~/app/api/auth/_twoFactorChallenge', () => ({
  createTwoFactorChallenge: vi.fn(),
  TWO_FACTOR_CHALLENGE_TTL_SECONDS: 600
}))

import { POST } from '~/app/api/auth/login/route'

const createRequest = () =>
  new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'user-agent': 'vitest' }
  }) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  recorder.reset()
})

describe('POST /api/auth/login 发出的 SQL', () => {
  it('邮箱形态的输入只查 email 列, 查不到也不再查 name 列, 输入原样绑定', async () => {
    parsePostMock.mockResolvedValue({
      name: 'kun_chan@qq.com',
      password: 'password1',
      captcha: 'captcha-token'
    })

    const res = await POST(createRequest())
    await expect(res.json()).resolves.toBe('用户名或密码错误')

    // 没查到 id 就不再按主键取整行
    const statements = dataStatements(recorder.take())
    expect(statements).toHaveLength(1)
    expectLowerEquals(statements, { column: 'email', bound: 'kun_chan@qq.com' })
  })

  it('用户名形态的输入只查 name 列', async () => {
    parsePostMock.mockResolvedValue({
      name: 'kun_chan%',
      password: 'password1',
      captcha: 'captcha-token'
    })

    const res = await POST(createRequest())
    await expect(res.json()).resolves.toBe('用户名或密码错误')

    const statements = dataStatements(recorder.take())
    expect(statements).toHaveLength(1)
    expectLowerEquals(statements, { column: 'name', bound: 'kun_chan%' })
  })
})
