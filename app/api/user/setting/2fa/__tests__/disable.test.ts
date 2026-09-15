import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  consumeBackupCodeMock,
  disable2FAMock,
  findUniqueMock,
  transactionMock,
  verifyHeaderCookieMock
} = vi.hoisted(() => ({
  consumeBackupCodeMock: vi.fn(),
  disable2FAMock: vi.fn(),
  findUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn()
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

vi.mock('time2fa', () => ({
  Totp: { validate: vi.fn() }
}))

vi.mock('~/app/api/utils/twoFactorBackupCode', () => ({
  consumeTwoFactorBackupCode: consumeBackupCodeMock
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
  consumeBackupCodeMock.mockResolvedValue(true)
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
    expect(consumeBackupCodeMock).toHaveBeenCalledWith(
      7,
      '123456',
      transactionClient
    )
    expect(disable2FAMock).toHaveBeenCalledWith(7, transactionClient)
    expect(consumeBackupCodeMock.mock.invocationCallOrder[0]).toBeLessThan(
      disable2FAMock.mock.invocationCallOrder[0]
    )
  })

  it('does not disable 2FA when the backup code is invalid', async () => {
    consumeBackupCodeMock.mockResolvedValue(false)

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe('验证码无效')
    expect(disable2FAMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid token with the shared parser message', async () => {
    const response = await POST(
      createRequest({ token: '12', isBackupCode: false })
    )

    await expect(response.json()).resolves.toBe('2FA 验证码必须为 6 位数字')
    expect(findUniqueMock).not.toHaveBeenCalled()
  })
})
