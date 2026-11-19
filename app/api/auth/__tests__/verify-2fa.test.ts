import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  consumeBackupCodeMock,
  consumeChallengeMock,
  cookieDeleteMock,
  cookieSetMock,
  findUniqueMock,
  establishSessionMock,
  getUserStatusMock,
  kunParsePostBodyMock,
  parseCookiesMock,
  reserveAttemptMock,
  checkTotpMock,
  verify2FAMock
} = vi.hoisted(() => ({
  consumeBackupCodeMock: vi.fn(),
  consumeChallengeMock: vi.fn(),
  cookieDeleteMock: vi.fn(),
  cookieSetMock: vi.fn(),
  findUniqueMock: vi.fn(),
  establishSessionMock: vi.fn(),
  getUserStatusMock: vi.fn(),
  kunParsePostBodyMock: vi.fn(),
  parseCookiesMock: vi.fn(),
  reserveAttemptMock: vi.fn(),
  checkTotpMock: vi.fn(),
  verify2FAMock: vi.fn()
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    delete: cookieDeleteMock,
    set: cookieSetMock
  })
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

vi.mock('~/server/auth/session', () => ({
  establishKunSession: establishSessionMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock } }
}))

vi.mock('~/app/api/user/status/service', () => ({
  getUserStatus: getUserStatusMock
}))

vi.mock('~/server/auth/secondFactor', () => ({
  checkTotp: checkTotpMock,
  SECOND_FACTOR_FAILURE_MESSAGE: {
    invalid: '验证码无效',
    replayed: '该验证码已经使用过, 请等身份验证器显示新的验证码后再试'
  }
}))

vi.mock('~/utils/cookies', () => ({
  parseCookies: parseCookiesMock
}))

vi.mock('~/app/api/utils/verify2FA', () => ({
  verify2FA: verify2FAMock
}))

vi.mock('~/app/api/utils/getRemoteIp', () => ({
  getRemoteIp: () => '203.0.113.8'
}))

vi.mock('~/app/api/auth/_twoFactorChallenge', () => ({
  consumeTwoFactorChallenge: consumeChallengeMock,
  reserveTwoFactorAttempt: reserveAttemptMock
}))

vi.mock('~/server/auth/twoFactorBackupCode', () => ({
  consumeTwoFactorBackupCode: consumeBackupCodeMock
}))

import { POST } from '~/app/api/auth/verify-2fa/route'

const user = {
  id: 7,
  name: 'tester',
  role: 1,
  enable_2fa: true,
  two_factor_secret: 'ABCDEFGHIJKLMN12',
  avatar: '',
  bio: '',
  moemoepoint: 0,
  daily_check_in: 0,
  daily_image_count: 0,
  daily_upload_size: 0,
  enable_email_notice: true,
  allow_private_message: true,
  blocked_tag_ids: []
}

const createRequest = () =>
  new Request('http://localhost/api/auth/verify-2fa', {
    method: 'POST',
    headers: {
      cookie: 'kun-galgame-patch-moe-2fa-token=temp-token',
      'user-agent': 'vitest'
    }
  }) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  vi.clearAllMocks()
  kunParsePostBodyMock.mockResolvedValue({
    token: '123456',
    isBackupCode: false
  })
  parseCookiesMock.mockReturnValue({
    'kun-galgame-patch-moe-2fa-token': 'temp-token'
  })
  verify2FAMock.mockReturnValue({
    id: 7,
    jti: 'challenge-id',
    require2FA: true
  })
  reserveAttemptMock.mockResolvedValue({
    allowed: true,
    remainingAttempts: 4
  })
  findUniqueMock.mockResolvedValue(user)
  checkTotpMock.mockResolvedValue('invalid')
  consumeChallengeMock.mockResolvedValue(true)
  establishSessionMock.mockResolvedValue({ ok: true })
  getUserStatusMock.mockResolvedValue({ uid: 7, name: 'tester' })
})

describe('POST /api/auth/verify-2fa', () => {
  it('locks further attempts without invalidating an in-flight challenge', async () => {
    reserveAttemptMock.mockResolvedValue({
      allowed: true,
      remainingAttempts: 0
    })

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe('2FA 尝试次数过多, 请重新登录')
    expect(cookieDeleteMock).toHaveBeenCalledWith(
      'kun-galgame-patch-moe-2fa-token'
    )
    expect(consumeChallengeMock).not.toHaveBeenCalled()
    expect(establishSessionMock).not.toHaveBeenCalled()
  })

  it('allows an earlier reserved correct request to finish after the fifth failure', async () => {
    const firstUserRead = Promise.withResolvers<typeof user>()
    reserveAttemptMock
      .mockResolvedValueOnce({ allowed: true, remainingAttempts: 4 })
      .mockResolvedValueOnce({ allowed: true, remainingAttempts: 0 })
    findUniqueMock
      .mockImplementationOnce(() => firstUserRead.promise)
      .mockResolvedValueOnce(user)
    checkTotpMock.mockResolvedValueOnce('invalid').mockResolvedValueOnce('ok')

    const earlierCorrectRequest = POST(createRequest())
    const fifthFailedResponse = await POST(createRequest())
    firstUserRead.resolve(user)
    const correctResponse = await earlierCorrectRequest

    await expect(fifthFailedResponse.json()).resolves.toBe(
      '2FA 尝试次数过多, 请重新登录'
    )
    expect(await correctResponse.json()).toMatchObject({ uid: 7 })
    expect(consumeChallengeMock).toHaveBeenCalledTimes(1)
    expect(establishSessionMock).toHaveBeenCalledTimes(1)
  })

  it('rejects uid or uid-ip limits before reading the user credential', async () => {
    reserveAttemptMock.mockResolvedValue({ allowed: false, reason: 'uid' })

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '2FA 尝试次数过多, 请稍后重新登录'
    )
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(cookieDeleteMock).toHaveBeenCalled()
  })

  it('consumes the challenge before issuing the access session', async () => {
    checkTotpMock.mockResolvedValue('ok')

    const response = await POST(createRequest())
    const body = await response.json()

    expect(body).toMatchObject({ uid: 7, name: 'tester' })
    expect(consumeChallengeMock).toHaveBeenCalledWith(
      'challenge-id',
      7,
      '203.0.113.8'
    )
    expect(consumeChallengeMock.mock.invocationCallOrder[0]).toBeLessThan(
      establishSessionMock.mock.invocationCallOrder[0]
    )
    // 会话由 establishKunSession 建立 (签发、写 cookie、记登录时间、复核封禁)
    expect(establishSessionMock).toHaveBeenCalledWith(user, {
      ip: '203.0.113.8',
      userAgent: 'vitest'
    })
    expect(getUserStatusMock).toHaveBeenCalledWith(7)
  })

  it('does not issue a second session when the same token is replayed', async () => {
    checkTotpMock.mockResolvedValue('ok')
    consumeChallengeMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const firstResponse = await POST(createRequest())
    const secondResponse = await POST(createRequest())

    expect(await firstResponse.json()).toMatchObject({ uid: 7 })
    await expect(secondResponse.json()).resolves.toBe(
      '2FA 临时令牌已失效, 请重新登录'
    )
    expect(establishSessionMock).toHaveBeenCalledTimes(1)
  })

  it('checks the TOTP code for this user against the stored secret', async () => {
    checkTotpMock.mockResolvedValue('ok')

    await POST(createRequest())

    expect(checkTotpMock).toHaveBeenCalledWith(7, 'ABCDEFGHIJKLMN12', '123456')
    expect(consumeBackupCodeMock).not.toHaveBeenCalled()
  })

  it('rejects a code whose time step was already used, without consuming the challenge', async () => {
    checkTotpMock.mockResolvedValue('replayed')

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '该验证码已经使用过, 请等身份验证器显示新的验证码后再试'
    )
    expect(consumeChallengeMock).not.toHaveBeenCalled()
    expect(establishSessionMock).not.toHaveBeenCalled()
  })

  it('fails closed when the used time step cannot be recorded', async () => {
    checkTotpMock.mockRejectedValue(new Error('redis unavailable'))

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '2FA 验证服务暂不可用, 请稍后重试'
    )
    expect(consumeChallengeMock).not.toHaveBeenCalled()
    expect(establishSessionMock).not.toHaveBeenCalled()
  })

  it('takes a backup code through the atomic consume, not the TOTP check', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      token: '654321',
      isBackupCode: true
    })
    consumeBackupCodeMock.mockResolvedValueOnce(false).mockResolvedValue(true)

    const rejected = await POST(createRequest())
    const accepted = await POST(createRequest())

    await expect(rejected.json()).resolves.toBe('验证码无效')
    expect(await accepted.json()).toMatchObject({ uid: 7 })
    expect(consumeBackupCodeMock).toHaveBeenCalledWith(7, '654321')
    expect(checkTotpMock).not.toHaveBeenCalled()
  })

  it('fails closed when Redis cannot reserve an attempt', async () => {
    reserveAttemptMock.mockRejectedValue(new Error('redis unavailable'))

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe(
      '2FA 验证服务暂不可用, 请稍后重试'
    )
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(establishSessionMock).not.toHaveBeenCalled()
  })

  it('第一步之后被封禁: 第二步通过也不建立会话, 回封禁消息', async () => {
    checkTotpMock.mockResolvedValue('ok')
    establishSessionMock.mockResolvedValue({ ok: false, message: 'banned' })

    const response = await POST(createRequest())

    await expect(response.json()).resolves.toBe('banned')
    expect(getUserStatusMock).not.toHaveBeenCalled()
  })
})
