import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dataStatements,
  expectEscapedIlike
} from '~/prisma/__tests__/support/sqlShape'

// 登录按用户名或邮箱找人依赖的编译器输出, 不连库: 条件走的是 ILIKE, 输入里的
// _ 和 % 不转义的话, 带下划线的账号会解析到别人那一行。按种类分列查询
// (server/identity/lookup.ts 的 findUserForLogin), 同一条语句里不再同时出现两列

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

const columnsOf = (sql: string) =>
  ['email', 'name'].filter((column) => sql.includes(`"${column}" ILIKE`))

describe('POST /api/auth/login 发出的 SQL', () => {
  it('邮箱形态的输入先单独查 email 列, 查不到再单独查 name 列, 都绑定转义过的输入', async () => {
    parsePostMock.mockResolvedValue({
      name: 'kun_chan@qq.com',
      password: 'password1',
      captcha: 'captcha-token'
    })

    const res = await POST(createRequest())
    await expect(res.json()).resolves.toBe('用户名或密码错误')

    const statements = dataStatements(recorder.take())
    expect(statements.map(({ sql }) => columnsOf(sql))).toEqual([
      ['email'],
      ['name']
    ])
    expectEscapedIlike(statements.slice(0, 1), {
      column: 'email',
      bound: 'kun\\_chan@qq.com'
    })
    expectEscapedIlike(statements.slice(1), {
      column: 'name',
      bound: 'kun\\_chan@qq.com'
    })
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
    expect(statements.map(({ sql }) => columnsOf(sql))).toEqual([['name']])
    expectEscapedIlike(statements, {
      column: 'name',
      bound: 'kun\\_chan\\%'
    })
  })
})
