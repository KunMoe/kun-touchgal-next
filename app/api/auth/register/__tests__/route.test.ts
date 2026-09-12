import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cookieSetMock,
  delKvMock,
  findFirstMock,
  getKvMock,
  kunParsePostBodyMock,
  userCreateMock,
  verifyVerificationCodeMock
} = vi.hoisted(() => ({
  cookieSetMock: vi.fn(),
  delKvMock: vi.fn(),
  findFirstMock: vi.fn(),
  getKvMock: vi.fn(),
  kunParsePostBodyMock: vi.fn(),
  userCreateMock: vi.fn(),
  verifyVerificationCodeMock: vi.fn()
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
  hashPassword: vi.fn(async () => 'password-hash')
}))

vi.mock('~/app/api/utils/verifyVerificationCode', () => ({
  verifyVerificationCode: verifyVerificationCodeMock
}))

vi.mock('~/app/api/utils/jwt', () => ({
  generateKunToken: vi.fn(async () => 'kun-token')
}))

vi.mock('~/app/api/utils/cookieOptions', () => ({
  kunCookieOptions: (maxAge: number) => ({ maxAge })
}))

vi.mock('~/lib/redis', () => ({
  delKv: delKvMock,
  getKv: getKvMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findFirst: findFirstMock, create: userCreateMock }
  }
}))

vi.mock('~/app/api/admin/setting/redirect/getRedirectConfig', () => ({
  getRedirectConfig: vi.fn(async () => ({}))
}))

import { Prisma } from '~/prisma/generated/prisma/client'
import { POST } from '~/app/api/auth/register/route'

const createRequest = (
  headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.8' }
) =>
  new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'user-agent': 'vitest', ...headers }
  }) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  vi.clearAllMocks()
  kunParsePostBodyMock.mockResolvedValue({
    name: 'tester',
    email: 'tester@example.com',
    code: 'abc1234',
    password: 'password1'
  })
  verifyVerificationCodeMock.mockResolvedValue(true)
  findFirstMock.mockResolvedValue(null)
  userCreateMock.mockResolvedValue({
    id: 7,
    name: 'tester',
    avatar: '',
    bio: '',
    moemoepoint: 0,
    role: 1,
    daily_check_in: 0,
    daily_image_count: 0,
    daily_upload_size: 0,
    enable_email_notice: true,
    allow_private_message: true,
    blocked_tag_ids: []
  })
  getKvMock.mockResolvedValue(null)
  delKvMock.mockResolvedValue(undefined)
})

describe('POST /api/auth/register with register disabled', () => {
  it('refuses to create a user while the kill switch is on', async () => {
    getKvMock.mockResolvedValue('true')

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '由于网站近日遭受大量攻击，当前时间段暂时不可注册，请明天下午再来，一定要来哦'
    )
    expect(userCreateMock).not.toHaveBeenCalled()
    expect(findFirstMock).not.toHaveBeenCalled()
    expect(verifyVerificationCodeMock).not.toHaveBeenCalled()
    expect(cookieSetMock).not.toHaveBeenCalled()
  })

  it('creates a user while the kill switch is off', async () => {
    const response = await POST(createRequest())
    const body = await response.json()

    expect(body).toMatchObject({ uid: 7, name: 'tester' })
    expect(userCreateMock).toHaveBeenCalledTimes(1)
    expect(cookieSetMock).toHaveBeenCalledWith(
      'kun-galgame-patch-moe-token',
      'kun-token',
      { maxAge: 30 * 24 * 60 * 60 }
    )
  })
})

describe('POST /api/auth/register verification code consumption', () => {
  it('consumes the verification code after the user is created', async () => {
    await POST(createRequest())

    expect(delKvMock).toHaveBeenCalledWith('tester@example.com')
    expect(userCreateMock.mock.invocationCallOrder[0]).toBeLessThan(
      delKvMock.mock.invocationCallOrder[0]
    )
  })

  it('keeps the code alive when registration fails before the user is created', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 1, name: 'tester' })

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '您的用户名已经有人注册了, 请修改'
    )
    expect(delKvMock).not.toHaveBeenCalled()
  })

  it('still returns the session when consuming the code fails', async () => {
    delKvMock.mockRejectedValue(new Error('redis unavailable'))

    const response = await POST(createRequest())
    const body = await response.json()

    expect(body).toMatchObject({ uid: 7 })
    expect(cookieSetMock).toHaveBeenCalled()
  })
})

describe('POST /api/auth/register unique constraint fallback', () => {
  it('reports a taken name or email claimed between the lookup and the insert', async () => {
    userCreateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '您的用户名或邮箱已经有人注册了, 请修改'
    )
    expect(cookieSetMock).not.toHaveBeenCalled()
    expect(delKvMock).not.toHaveBeenCalled()
  })

  it('does not swallow unrelated prisma errors', async () => {
    userCreateMock.mockRejectedValue(new Error('connection lost'))

    await expect(POST(createRequest())).rejects.toThrow('connection lost')
    expect(cookieSetMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/auth/register remote ip gate', () => {
  it('accepts a request that only carries CF-Connecting-IP', async () => {
    const response = await POST(
      createRequest({ 'CF-Connecting-IP': '203.0.113.8' })
    )

    await expect(response.json()).resolves.toMatchObject({ uid: 7 })
  })

  it('rejects a request without any client ip header before touching the store', async () => {
    const response = await POST(createRequest({}))

    await expect(response.json()).resolves.toBe('读取请求头失败')
    expect(verifyVerificationCodeMock).not.toHaveBeenCalled()
    expect(userCreateMock).not.toHaveBeenCalled()
  })
})
