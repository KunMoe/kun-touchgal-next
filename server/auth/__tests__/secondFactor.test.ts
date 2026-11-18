import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  consumeBackupCodeMock,
  findUniqueMock,
  reserveAttemptMock,
  setKvIfAbsentMock,
  settleSuccessMock
} = vi.hoisted(() => ({
  consumeBackupCodeMock: vi.fn(),
  findUniqueMock: vi.fn(),
  reserveAttemptMock: vi.fn(),
  setKvIfAbsentMock: vi.fn(),
  settleSuccessMock: vi.fn()
}))

vi.mock('~/lib/redis', () => ({ setKvIfAbsent: setKvIfAbsentMock }))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock } }
}))

vi.mock('~/server/auth/attemptBudget', () => ({
  reserveAttempt: reserveAttemptMock,
  settleSuccess: settleSuccessMock
}))

vi.mock('~/server/auth/twoFactorBackupCode', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('~/server/auth/twoFactorBackupCode')
  >()),
  consumeTwoFactorBackupCode: consumeBackupCodeMock
}))

import {
  checkTotp,
  createTotpKey,
  issueBackupCodes,
  matchTotpStep,
  verifyEnrollmentCode,
  verifySecondFactor
} from '~/server/auth/secondFactor'
import { hashTwoFactorBackupCode } from '~/server/auth/twoFactorBackupCode'

// 不借 time2fa 自己来当答案: 按 RFC 4226 / 6238 用 node:crypto 独立算一遍
// (HMAC-SHA1、动态截断、6 位、30 秒步长), 身份验证器应用算出来的就是这个值
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const decodeBase32 = (value: string) => {
  const bits = [...value]
    .map((char) => BASE32.indexOf(char).toString(2).padStart(5, '0'))
    .join('')
  const bytes = bits.match(/.{8}/g) ?? []
  return Buffer.from(bytes.map((byte) => parseInt(byte, 2)))
}
const referenceCode = (secret: string, step: number) => {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', decodeBase32(secret))
    .update(counter)
    .digest()
  const offset = digest[digest.length - 1] & 0xf
  const value = digest.readUInt32BE(offset) & 0x7fffffff
  return String(value % 1_000_000).padStart(6, '0')
}

// 10 字节密钥的 base32 (16 个字符), 与 time2fa 生成的形状一致
const SECRET = 'JBSWY3DPEHPK3PXP'
const STEP = 59_000_000
const NOW = STEP * 30_000 + 12_000

const enabledUser = { enable_2fa: true, two_factor_secret: SECRET }

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubEnv(
    'KUN_TWO_FACTOR_BACKUP_PEPPER',
    'test-only-two-factor-backup-pepper-1234567890'
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  reserveAttemptMock.mockResolvedValue({ allowed: true, remaining: [9, 4] })
  settleSuccessMock.mockResolvedValue(true)
  setKvIfAbsentMock.mockResolvedValue(true)
  findUniqueMock.mockResolvedValue(enabledUser)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('matchTotpStep', () => {
  it('returns the matched time step for the current, previous and next code', () => {
    expect(matchTotpStep(SECRET, referenceCode(SECRET, STEP), NOW)).toBe(STEP)
    expect(matchTotpStep(SECRET, referenceCode(SECRET, STEP - 1), NOW)).toBe(
      STEP - 1
    )
    expect(matchTotpStep(SECRET, referenceCode(SECRET, STEP + 1), NOW)).toBe(
      STEP + 1
    )
  })

  it('rejects codes two steps away in either direction', () => {
    expect(
      matchTotpStep(SECRET, referenceCode(SECRET, STEP - 2), NOW)
    ).toBeNull()
    expect(
      matchTotpStep(SECRET, referenceCode(SECRET, STEP + 2), NOW)
    ).toBeNull()
  })

  it('moves the window exactly at the 30-second boundary', () => {
    const code = referenceCode(SECRET, STEP - 1)

    // 当前步的最后一毫秒: 前一步的码还在窗口内
    expect(matchTotpStep(SECRET, code, (STEP + 1) * 30_000 - 1)).toBe(STEP - 1)
    // 进入下一步: 它成了两步之前的码
    expect(matchTotpStep(SECRET, code, (STEP + 1) * 30_000)).toBeNull()
  })

  it('depends only on the time passed in, not on the clock', () => {
    vi.setSystemTime(0)

    expect(matchTotpStep(SECRET, referenceCode(SECRET, STEP), NOW)).toBe(STEP)
  })

  it('ignores whitespace and rejects anything that is not six characters', () => {
    const code = referenceCode(SECRET, STEP)

    expect(
      matchTotpStep(SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, NOW)
    ).toBe(STEP)
    expect(matchTotpStep(SECRET, code.slice(0, 5), NOW)).toBeNull()
    expect(matchTotpStep(SECRET, `${code}0`, NOW)).toBeNull()
    expect(matchTotpStep(SECRET, '', NOW)).toBeNull()
  })

  it('does not accept a code derived from another secret', () => {
    expect(
      matchTotpStep(SECRET, referenceCode('KRSXG5CTMVRXEZLU', STEP), NOW)
    ).toBeNull()
  })
})

describe('checkTotp', () => {
  it('records the matched time step per user for two minutes', async () => {
    await expect(
      checkTotp(7, SECRET, referenceCode(SECRET, STEP - 1))
    ).resolves.toBe('ok')

    expect(setKvIfAbsentMock).toHaveBeenCalledExactlyOnceWith(
      `auth:totp:used:7:${STEP - 1}`,
      '1',
      120
    )
  })

  it('reports a replay when the time step was already recorded', async () => {
    setKvIfAbsentMock.mockResolvedValue(false)

    await expect(
      checkTotp(7, SECRET, referenceCode(SECRET, STEP))
    ).resolves.toBe('replayed')
  })

  it('does not record anything for a wrong code', async () => {
    await expect(checkTotp(7, SECRET, '000000')).resolves.toBe('invalid')

    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('throws when the time step cannot be recorded', async () => {
    setKvIfAbsentMock.mockRejectedValue(new Error('redis unavailable'))

    await expect(
      checkTotp(7, SECRET, referenceCode(SECRET, STEP))
    ).rejects.toThrow('redis unavailable')
  })
})

describe('verifySecondFactor', () => {
  const totp = () =>
    ({ kind: 'totp', code: referenceCode(SECRET, STEP) }) as const
  const ctx = { ip: '203.0.113.8' }

  it('reserves the step-up budget, checks the code, then settles the same budget', async () => {
    await expect(verifySecondFactor(7, totp(), ctx)).resolves.toEqual({
      ok: true
    })

    const [dims] = reserveAttemptMock.mock.calls[0]
    expect(dims.map((dim: { key: string }) => dim.key)).toEqual([
      'auth:stepup:2fa:uid:7',
      expect.stringMatching(/^auth:stepup:2fa:uid-ip:7:[0-9a-f]{64}$/)
    ])
    expect(settleSuccessMock).toHaveBeenCalledExactlyOnceWith(dims)
    expect(reserveAttemptMock.mock.invocationCallOrder[0]).toBeLessThan(
      findUniqueMock.mock.invocationCallOrder[0]
    )
    expect(setKvIfAbsentMock.mock.invocationCallOrder[0]).toBeLessThan(
      settleSuccessMock.mock.invocationCallOrder[0]
    )
  })

  it('refuses without reading any credential when the budget is used up', async () => {
    reserveAttemptMock.mockResolvedValue({
      allowed: false,
      reason: 'exhausted',
      dimension: 'auth:stepup:2fa:uid:7'
    })

    await expect(verifySecondFactor(7, totp(), ctx)).resolves.toEqual({
      ok: false,
      reason: 'locked'
    })
    await expect(
      verifySecondFactor(7, { kind: 'backup', code: '123456' }, ctx)
    ).resolves.toEqual({ ok: false, reason: 'locked' })

    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(consumeBackupCodeMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('fails closed when the budget cannot be reserved', async () => {
    reserveAttemptMock.mockRejectedValue(new Error('redis unavailable'))

    await expect(verifySecondFactor(7, totp(), ctx)).resolves.toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(findUniqueMock).not.toHaveBeenCalled()
  })

  it('keeps the reservation charged for a wrong or replayed code', async () => {
    await expect(
      verifySecondFactor(7, { kind: 'totp', code: '000000' }, ctx)
    ).resolves.toEqual({ ok: false, reason: 'invalid' })

    setKvIfAbsentMock.mockResolvedValue(false)
    await expect(verifySecondFactor(7, totp(), ctx)).resolves.toEqual({
      ok: false,
      reason: 'replayed'
    })

    expect(settleSuccessMock).not.toHaveBeenCalled()
  })

  it('fails closed when the used time step cannot be recorded', async () => {
    setKvIfAbsentMock.mockRejectedValue(new Error('redis unavailable'))

    await expect(verifySecondFactor(7, totp(), ctx)).resolves.toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(settleSuccessMock).not.toHaveBeenCalled()
  })

  it.each([
    ['2FA is not enabled', { enable_2fa: false, two_factor_secret: SECRET }],
    ['the secret is empty', { enable_2fa: true, two_factor_secret: '' }],
    ['the user is gone', null]
  ])('treats a TOTP code as wrong when %s', async (_, user) => {
    findUniqueMock.mockResolvedValue(user)

    await expect(verifySecondFactor(7, totp(), ctx)).resolves.toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
    expect(settleSuccessMock).not.toHaveBeenCalled()
  })

  it('consumes a backup code on the given transaction client', async () => {
    const tx = { user: { findUnique: vi.fn() } }
    consumeBackupCodeMock.mockResolvedValue(true)

    await expect(
      verifySecondFactor(
        7,
        { kind: 'backup', code: '123456' },
        { ...ctx, db: tx as never }
      )
    ).resolves.toEqual({ ok: true })

    expect(consumeBackupCodeMock).toHaveBeenCalledExactlyOnceWith(
      7,
      '123456',
      tx
    )
    expect(settleSuccessMock).toHaveBeenCalledTimes(1)
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('keeps the reservation charged for a wrong backup code', async () => {
    consumeBackupCodeMock.mockResolvedValue(false)

    await expect(
      verifySecondFactor(7, { kind: 'backup', code: '123456' }, ctx)
    ).resolves.toEqual({ ok: false, reason: 'invalid' })
    expect(settleSuccessMock).not.toHaveBeenCalled()
  })

  // 备份码此时已被消费: 清不掉计数不能让这次验证判失败
  it('still succeeds when the counters cannot be cleared afterwards', async () => {
    consumeBackupCodeMock.mockResolvedValue(true)
    settleSuccessMock.mockRejectedValue(new Error('redis unavailable'))

    await expect(
      verifySecondFactor(7, { kind: 'backup', code: '123456' }, ctx)
    ).resolves.toEqual({ ok: true })
  })

  it('lets a database failure surface instead of reporting a wrong code', async () => {
    consumeBackupCodeMock.mockRejectedValue(new Error('connection lost'))

    await expect(
      verifySecondFactor(7, { kind: 'backup', code: '123456' }, ctx)
    ).rejects.toThrow('connection lost')
  })
})

describe('verifyEnrollmentCode', () => {
  it('checks the pending secret it is given under the same budget and replay registry', async () => {
    await expect(
      verifyEnrollmentCode(7, SECRET, referenceCode(SECRET, STEP), { ip: '' })
    ).resolves.toEqual({ ok: true })

    const [dims] = reserveAttemptMock.mock.calls[0]
    expect(dims.map((dim: { key: string }) => dim.key)).toEqual([
      'auth:stepup:2fa:uid:7'
    ])
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).toHaveBeenCalledWith(
      `auth:totp:used:7:${STEP}`,
      '1',
      120
    )
    expect(settleSuccessMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a wrong code without settling', async () => {
    await expect(
      verifyEnrollmentCode(7, SECRET, '000000', { ip: '' })
    ).resolves.toEqual({ ok: false, reason: 'invalid' })
    expect(settleSuccessMock).not.toHaveBeenCalled()
  })
})

describe('issuing', () => {
  it('creates a key an authenticator app can use', () => {
    const key = createTotpKey('TouchGal', 'tester')

    expect(key.secret).toMatch(/^[A-Z2-7]{16}$/)
    const url = new URL(key.url)
    expect(url.protocol).toBe('otpauth:')
    expect(url.searchParams.get('secret')).toBe(key.secret)
    expect(url.searchParams.get('issuer')).toBe('TouchGal')
    expect(decodeURIComponent(url.pathname)).toContain('TouchGal:tester')
    // 新密钥算出来的码能被自己的校验接受
    expect(
      matchTotpStep(key.secret, referenceCode(key.secret, STEP), NOW)
    ).toBe(STEP)
  })

  it('returns ten backup codes and stores only their hashes', () => {
    const codes = issueBackupCodes()

    expect(codes.plain).toHaveLength(10)
    expect(new Set(codes.plain).size).toBe(10)
    expect(codes.plain.every((code) => /^\d{6}$/.test(code))).toBe(true)
    expect(codes.stored).toEqual(codes.plain.map(hashTwoFactorBackupCode))
    expect(codes.stored.every((code) => /^h1:[0-9a-f]{64}$/.test(code))).toBe(
      true
    )
  })
})
