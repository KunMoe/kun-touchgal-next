import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseLowerLookup } from '~/server/identity/__tests__/support/lowerLookup'

const {
  checkCaptchaMock,
  getKvMock,
  kunParsePostBodyMock,
  queryRawMock,
  sendVerificationCodeEmailMock
} = vi.hoisted(() => ({
  checkCaptchaMock: vi.fn(),
  getKvMock: vi.fn(),
  kunParsePostBodyMock: vi.fn(),
  queryRawMock: vi.fn(),
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
  // $queryRaw 是 server/identity/lookup.ts 按 lower() 的查重
  prisma: { $queryRaw: queryRawMock }
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
  queryRawMock.mockResolvedValue([])
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
    expect(parseLowerLookup(queryRawMock.mock.calls[1][0])).toEqual({
      column: 'email',
      value: 'Tester@Example.com',
      exceptUid: null
    })
    expect(sendVerificationCodeEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      'Tester@Example.com',
      'register'
    )
  })

  // 查重是 lower(列) = lower(参数) 的字面比较, _ 与 % 不是通配符, 不需要也不能转义
  it('binds the name and email as typed, without escaping or lowercasing', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      name: 'k_n',
      email: 'kun_chan@qq.com',
      captcha: 'captcha-token'
    })

    await POST(createRequest())

    expect(
      queryRawMock.mock.calls.map(([query]) => parseLowerLookup(query))
    ).toEqual([
      { column: 'name', value: 'k_n', exceptUid: null },
      { column: 'email', value: 'kun_chan@qq.com', exceptUid: null }
    ])
    expect(sendVerificationCodeEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      'kun_chan@qq.com',
      'register'
    )
  })

  it('refuses to send a code when the email is already registered', async () => {
    queryRawMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 1 }])

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '您的邮箱已经有人注册了, 请修改'
    )
    expect(sendVerificationCodeEmailMock).not.toHaveBeenCalled()
  })
})
