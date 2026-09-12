import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  checkCaptchaMock,
  findFirstMock,
  getKvMock,
  kunParsePostBodyMock,
  sendVerificationCodeEmailMock
} = vi.hoisted(() => ({
  checkCaptchaMock: vi.fn(),
  findFirstMock: vi.fn(),
  getKvMock: vi.fn(),
  kunParsePostBodyMock: vi.fn(),
  sendVerificationCodeEmailMock: vi.fn()
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

vi.mock('~/app/api/utils/sendVerificationCodeEmail', () => ({
  sendVerificationCodeEmail: sendVerificationCodeEmailMock
}))

vi.mock('~/app/api/utils/verifyKunCaptcha', () => ({
  checkKunCaptchaExist: checkCaptchaMock
}))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findFirst: findFirstMock }
  }
}))

import { POST } from '~/app/api/auth/send-register-code/route'

const createRequest = (
  headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.8' }
) =>
  new Request('http://localhost/api/auth/send-register-code', {
    method: 'POST',
    headers
  }) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  vi.clearAllMocks()
  kunParsePostBodyMock.mockResolvedValue({
    name: 'tester',
    email: 'tester@example.com',
    captcha: 'captcha-token'
  })
  checkCaptchaMock.mockResolvedValue(true)
  findFirstMock.mockResolvedValue(null)
  sendVerificationCodeEmailMock.mockResolvedValue(undefined)
  getKvMock.mockResolvedValue(null)
})

describe('POST /api/auth/send-register-code with register disabled', () => {
  it('rejects before the one-time captcha token is consumed', async () => {
    getKvMock.mockResolvedValue('true')

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '由于网站近日遭受大量攻击，当前时间段暂时不可注册，请明天下午再来，一定要来哦'
    )
    expect(checkCaptchaMock).not.toHaveBeenCalled()
    expect(sendVerificationCodeEmailMock).not.toHaveBeenCalled()
  })

  it('still verifies the captcha while the kill switch is off', async () => {
    const response = await POST(createRequest())

    await expect(response.json()).resolves.toEqual({})
    expect(checkCaptchaMock).toHaveBeenCalledWith('captcha-token')
    expect(sendVerificationCodeEmailMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/auth/send-register-code remote ip gate', () => {
  it.each(['CF-Connecting-IP', 'x-real-ip'])(
    'accepts a request that only carries %s',
    async (header) => {
      const response = await POST(createRequest({ [header]: '203.0.113.8' }))

      await expect(response.json()).resolves.toEqual({})
      expect(sendVerificationCodeEmailMock).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects a request without any client ip header before consuming the captcha', async () => {
    const response = await POST(createRequest({}))

    await expect(response.json()).resolves.toBe('读取请求头失败')
    expect(checkCaptchaMock).not.toHaveBeenCalled()
    expect(sendVerificationCodeEmailMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/auth/send-register-code email dedup', () => {
  it('looks the email up case-insensitively and keeps the raw address for delivery', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      name: 'tester',
      email: 'Tester@Example.com',
      captcha: 'captcha-token'
    })

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toEqual({})
    expect(findFirstMock).toHaveBeenNthCalledWith(2, {
      where: { email: { equals: 'Tester@Example.com', mode: 'insensitive' } }
    })
    expect(sendVerificationCodeEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      'Tester@Example.com',
      'register'
    )
  })

  it('escapes LIKE wildcards so an underscore cannot match other names or addresses', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      name: 'k_n',
      email: 'kun_chan@qq.com',
      captcha: 'captcha-token'
    })

    await POST(createRequest())

    expect(findFirstMock).toHaveBeenNthCalledWith(1, {
      where: { name: { equals: 'k\\_n', mode: 'insensitive' } }
    })
    expect(findFirstMock).toHaveBeenNthCalledWith(2, {
      where: { email: { equals: 'kun\\_chan@qq.com', mode: 'insensitive' } }
    })
    expect(sendVerificationCodeEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      'kun_chan@qq.com',
      'register'
    )
  })

  it('refuses to send a code when the email is already registered', async () => {
    findFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1, email: 'tester@example.com' })

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '您的邮箱已经有人注册了, 请修改'
    )
    expect(sendVerificationCodeEmailMock).not.toHaveBeenCalled()
  })
})
