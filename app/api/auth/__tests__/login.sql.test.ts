import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectEscapedIlike } from '~/prisma/__tests__/support/sqlShape'

// 登录按用户名或邮箱找人依赖的编译器输出, 不连库: 这两个条件走的是 ILIKE, 输入里的
// _ 和 % 不转义的话, 带下划线的账号会解析到别人那一行

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
  it('用户名与邮箱两个条件都走 ILIKE, 绑定的是转义过通配符的输入', async () => {
    parsePostMock.mockResolvedValue({
      name: 'kun_chan%@qq.com',
      password: 'password1',
      captcha: 'captcha-token'
    })

    const res = await POST(createRequest())
    await expect(res.json()).resolves.toBe('用户名或密码错误')

    const statements = recorder.take()
    expect(statements).toHaveLength(1)
    expectEscapedIlike(statements, {
      column: 'email',
      bound: 'kun\\_chan\\%@qq.com'
    })
    expectEscapedIlike(statements, {
      column: 'name',
      bound: 'kun\\_chan\\%@qq.com'
    })
  })
})
