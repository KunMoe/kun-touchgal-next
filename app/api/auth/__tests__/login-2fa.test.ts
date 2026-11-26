import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerLowerLookup,
  parseLowerLookup
} from '~/server/identity/__tests__/support/lowerLookup'

const {
  checkCaptchaMock,
  cookieSetMock,
  createChallengeMock,
  establishSessionMock,
  findUniqueMock,
  generateStatelessTokenMock,
  getUserStatusMock,
  kunParsePostBodyMock,
  queryRawMock,
  verifyPasswordMock
} = vi.hoisted(() => ({
  checkCaptchaMock: vi.fn(),
  cookieSetMock: vi.fn(),
  createChallengeMock: vi.fn(),
  establishSessionMock: vi.fn(),
  findUniqueMock: vi.fn(),
  generateStatelessTokenMock: vi.fn(),
  getUserStatusMock: vi.fn(),
  kunParsePostBodyMock: vi.fn(),
  queryRawMock: vi.fn(),
  verifyPasswordMock: vi.fn()
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSetMock })
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
  kunParsePostBody: kunParsePostBodyMock
}))

vi.mock('~/app/api/utils/algorithm', () => ({
  DUMMY_PASSWORD_HASH: 'dummy',
  hashPassword: vi.fn(),
  needsPasswordRehash: () => false,
  verifyPassword: verifyPasswordMock
}))

vi.mock('~/server/auth/session', () => ({
  establishKunSession: establishSessionMock,
  generateKunStatelessToken: generateStatelessTokenMock,
  KUN_BANNED_LOGIN_MESSAGE: 'banned'
}))

vi.mock('~/server/auth/cookieOptions', () => ({
  kunCookieOptions: (maxAge: number) => ({ maxAge })
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    $queryRaw: queryRawMock,
    user: { findUnique: findUniqueMock, updateMany: vi.fn() }
  }
}))

vi.mock('~/app/api/utils/verifyKunCaptcha', () => ({
  checkKunCaptchaExist: checkCaptchaMock
}))

vi.mock('~/app/api/user/status/service', () => ({
  getUserStatus: getUserStatusMock
}))

vi.mock('~/app/api/utils/getRemoteIp', () => ({
  getRemoteIp: () => '203.0.113.8'
}))

vi.mock('~/app/api/auth/_twoFactorChallenge', () => ({
  createTwoFactorChallenge: createChallengeMock,
  TWO_FACTOR_CHALLENGE_TTL_SECONDS: 600
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { POST } from '~/app/api/auth/login/route'
import { kunLog } from '~/lib/log.server'

const createRequest = () =>
  new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'user-agent': 'vitest' }
  }) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  vi.clearAllMocks()
  kunParsePostBodyMock.mockResolvedValue({
    name: 'tester',
    password: 'password1',
    captcha: 'captcha-token'
  })
  checkCaptchaMock.mockResolvedValue(true)
  verifyPasswordMock.mockResolvedValue(true)
  // server/identity/lookup.ts 先按 lower() 索引取 id, 再按主键取整行
  queryRawMock.mockResolvedValue([{ id: 7 }])
  findUniqueMock.mockResolvedValue({
    id: 7,
    name: 'tester',
    email: 'tester@example.com',
    password: 'password-hash',
    status: 0,
    enable_2fa: true,
    avatar: ''
  })
  createChallengeMock.mockResolvedValue(undefined)
  generateStatelessTokenMock.mockReturnValue('temp-token')
})

describe('POST /api/auth/login with 2FA', () => {
  it('stores a stateful challenge before setting the temporary token', async () => {
    const response = await POST(createRequest())
    const body = await response.json()

    expect(body).toMatchObject({ require2FA: true, id: 7 })
    const jti = createChallengeMock.mock.calls[0][0]
    expect(jti).toEqual(expect.any(String))
    expect(createChallengeMock).toHaveBeenCalledWith(jti, 7)
    // 带上第一步读到的安全戳 (库里为 null 时是 0), 第二步拿它与自己读到的那一行比
    expect(generateStatelessTokenMock).toHaveBeenCalledWith(
      { id: 7, require2FA: true, jti, cs: 0 },
      600
    )
    expect(createChallengeMock.mock.invocationCallOrder[0]).toBeLessThan(
      cookieSetMock.mock.invocationCallOrder[0]
    )
    expect(cookieSetMock).toHaveBeenCalledWith(
      'kun-galgame-patch-moe-2fa-token',
      'temp-token',
      { maxAge: 600 }
    )
  })

  it('does not issue a stateless fallback when Redis is unavailable', async () => {
    const error = new Error('redis unavailable')
    createChallengeMock.mockRejectedValue(error)

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '2FA 验证服务暂不可用, 请稍后重试'
    )
    expect(generateStatelessTokenMock).not.toHaveBeenCalled()
    expect(cookieSetMock).not.toHaveBeenCalled()
    expect(kunLog).toHaveBeenCalledWith(
      'auth.dependency_failed',
      { stage: '2fa_challenge_create' },
      error
    )
  })
})

describe('POST /api/auth/login without 2FA', () => {
  const row = {
    id: 7,
    name: 'tester',
    email: 'tester@example.com',
    password: 'password-hash',
    role: 1,
    status: 0,
    enable_2fa: false,
    avatar: ''
  }

  beforeEach(() => {
    findUniqueMock.mockResolvedValue(row)
    establishSessionMock.mockResolvedValue({ ok: true })
    getUserStatusMock.mockResolvedValue({ uid: 7, name: 'tester' })
  })

  it('建立会话用的是校验密码时读到的那一行, 回给客户端的状态取自 getUserStatus', async () => {
    const body = await (await POST(createRequest())).json()

    expect(establishSessionMock).toHaveBeenCalledWith(row, {
      ip: '203.0.113.8',
      userAgent: 'vitest'
    })
    expect(getUserStatusMock).toHaveBeenCalledWith(7)
    expect(body).toEqual({ uid: 7, name: 'tester', require2FA: false })
    expect(createChallengeMock).not.toHaveBeenCalled()
  })

  it('会话没建成时原样回它的消息, 不读用户状态', async () => {
    establishSessionMock.mockResolvedValue({ ok: false, message: 'banned' })

    const body = await (await POST(createRequest())).json()

    expect(body).toBe('banned')
    expect(getUserStatusMock).not.toHaveBeenCalled()
  })

  it('封禁的账号在建立会话之前就被拒绝', async () => {
    findUniqueMock.mockResolvedValue({ ...row, status: 2 })

    const body = await (await POST(createRequest())).json()

    expect(body).toBe('banned')
    expect(establishSessionMock).not.toHaveBeenCalled()
  })
})

// P07-02 / X07-03: 有人把用户名改成别人的邮箱之后, 登录以前用一条 OR 同时查两列且不排序,
// 在两行里随机取一行, 邮箱的持有者可能一直登不进去。这里按 lookup 那条原生查询的列
// 模拟库 (server/identity/__tests__/support/lowerLookup.ts), 再按主键取整行
describe('POST /api/auth/login 按种类解析登录标识符', () => {
  const owner = {
    id: 1,
    name: 'victim',
    email: 'Victim@QQ.com',
    password: 'owner-hash',
    role: 1,
    status: 0,
    enable_2fa: false,
    avatar: ''
  }
  const squatter = {
    ...owner,
    id: 2,
    name: 'victim@qq.com',
    email: 'attacker@qq.com',
    password: 'squatter-hash'
  }

  const rows = [owner, squatter]

  beforeEach(() => {
    queryRawMock.mockImplementation(async (query: unknown) =>
      answerLowerLookup(rows, query)
    )
    findUniqueMock.mockImplementation(
      async ({ where }: { where: { id: number } }) =>
        rows.find((row) => row.id === where.id) ?? null
    )
    establishSessionMock.mockResolvedValue({ ok: true })
    getUserStatusMock.mockResolvedValue({ uid: 1, name: 'victim' })
  })

  const queriedColumns = () =>
    queryRawMock.mock.calls.map(([query]) => parseLowerLookup(query).column)

  const loginWith = async (name: string) => {
    kunParsePostBodyMock.mockResolvedValue({
      name,
      password: 'password1',
      captcha: 'captcha-token'
    })
    return (await POST(createRequest())).json()
  }

  it('邮箱形态的输入只查 email 列, 邮箱的持有者登得进去', async () => {
    await loginWith('victim@qq.com')

    expect(verifyPasswordMock).toHaveBeenCalledWith('password1', 'owner-hash')
    expect(establishSessionMock).toHaveBeenCalledWith(owner, expect.anything())
    expect(queriedColumns()).toEqual(['email'])
  })

  it('用户名形态的输入只查 name 列', async () => {
    await loginWith('Victim')

    expect(establishSessionMock).toHaveBeenCalledWith(owner, expect.anything())
    expect(queriedColumns()).toEqual(['name'])
  })
})
