import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  disable2FAMock,
  findUniqueMock,
  transactionMock,
  verifyHeaderCookieMock,
  verifySecondFactorMock
} = vi.hoisted(() => ({
  disable2FAMock: vi.fn(),
  findUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  verifySecondFactorMock: vi.fn()
}))

const transactionClient = {
  $executeRaw: vi.fn(),
  user: { update: vi.fn() }
}

vi.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    $transaction: transactionMock,
    user: { findUnique: findUniqueMock }
  }
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/server/auth/secondFactor', () => ({
  verifySecondFactor: verifySecondFactorMock,
  SECOND_FACTOR_FAILURE_MESSAGE: {
    invalid: '验证码无效',
    replayed: '该验证码已经使用过, 请等身份验证器显示新的验证码后再试',
    locked: '验证尝试次数过多, 请 15 分钟后再试',
    unavailable: '验证服务暂不可用, 请稍后重试'
  }
}))

vi.mock('~/app/api/user/setting/2fa/disable', () => ({
  disable2FA: disable2FAMock
}))

import { POST } from '~/app/api/user/setting/2fa/disable/route'

const createRequest = (
  body: unknown = { token: '123456', isBackupCode: true }
) =>
  new Request('http://localhost/api/user/setting/2fa/disable', {
    method: 'POST',
    headers: { 'x-real-ip': '203.0.113.8' },
    body: JSON.stringify(body)
  }) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  vi.clearAllMocks()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 7 })
  findUniqueMock.mockResolvedValue({
    enable_2fa: true,
    two_factor_secret: 'ABCDEFGHIJKLMN12'
  })
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
  verifySecondFactorMock.mockResolvedValue({ ok: true })
  disable2FAMock.mockResolvedValue({ success: true, message: '2FA 已禁用' })
})

describe('POST /api/user/setting/2fa/disable', () => {
  it('consumes a backup code and disables 2FA in the same transaction', async () => {
    const response = await POST(createRequest())

    await expect(response.json()).resolves.toEqual({
      success: true,
      message: '2FA 已禁用'
    })
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(verifySecondFactorMock).toHaveBeenCalledWith(
      7,
      { kind: 'backup', code: '123456' },
      { ip: '203.0.113.8', db: transactionClient }
    )
    expect(disable2FAMock).toHaveBeenCalledWith(7, transactionClient)
    expect(verifySecondFactorMock.mock.invocationCallOrder[0]).toBeLessThan(
      disable2FAMock.mock.invocationCallOrder[0]
    )
  })

  it('does not disable 2FA when the backup code is invalid', async () => {
    verifySecondFactorMock.mockResolvedValue({ ok: false, reason: 'invalid' })

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe('验证码无效')
    expect(disable2FAMock).not.toHaveBeenCalled()
  })

  it('verifies a TOTP code outside any transaction before disabling', async () => {
    const response = await POST(
      createRequest({ token: '123456', isBackupCode: false })
    )

    await expect(response.json()).resolves.toEqual({
      success: true,
      message: '2FA 已禁用'
    })
    expect(verifySecondFactorMock).toHaveBeenCalledWith(
      7,
      { kind: 'totp', code: '123456' },
      { ip: '203.0.113.8' }
    )
    expect(transactionMock).not.toHaveBeenCalled()
    expect(disable2FAMock).toHaveBeenCalledWith(7)
  })

  it.each([
    ['replayed', '该验证码已经使用过, 请等身份验证器显示新的验证码后再试'],
    ['locked', '验证尝试次数过多, 请 15 分钟后再试'],
    ['unavailable', '验证服务暂不可用, 请稍后重试']
  ])(
    'keeps 2FA on when the check is %s, for either kind of code',
    async (reason, message) => {
      verifySecondFactorMock.mockResolvedValue({ ok: false, reason })

      const viaTotp = await POST(
        createRequest({ token: '123456', isBackupCode: false })
      )
      const viaBackup = await POST(createRequest())

      await expect(viaTotp.json()).resolves.toBe(message)
      await expect(viaBackup.json()).resolves.toBe(message)
      expect(disable2FAMock).not.toHaveBeenCalled()
    }
  )

  it('rejects an invalid token with the shared parser message', async () => {
    const response = await POST(
      createRequest({ token: '12', isBackupCode: false })
    )

    await expect(response.json()).resolves.toBe('2FA 验证码必须为 6 位数字')
    expect(findUniqueMock).not.toHaveBeenCalled()
  })
})
