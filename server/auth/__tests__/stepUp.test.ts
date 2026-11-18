import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  consumeBackupCodeMock,
  findUniqueMock,
  reserveAttemptMock,
  settleSuccessMock,
  verifyPasswordMock,
  verifySecondFactorMock
} = vi.hoisted(() => ({
  consumeBackupCodeMock: vi.fn(),
  findUniqueMock: vi.fn(),
  reserveAttemptMock: vi.fn(),
  settleSuccessMock: vi.fn(),
  verifyPasswordMock: vi.fn(),
  verifySecondFactorMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock } }
}))

vi.mock('~/server/auth/attemptBudget', () => ({
  reserveAttempt: reserveAttemptMock,
  settleSuccess: settleSuccessMock
}))

vi.mock('~/server/auth/algorithm', () => ({
  verifyPassword: verifyPasswordMock
}))

vi.mock('~/server/auth/twoFactorBackupCode', () => ({
  consumeTwoFactorBackupCode: consumeBackupCodeMock
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

import {
  consumeStepUpBackupCode,
  requireStepUp,
  STEP_UP_POLICY
} from '~/server/auth/stepUp'

const ctx = { ip: '203.0.113.8' }
const user = (enable_2fa: boolean) => ({ password: 'stored-hash', enable_2fa })

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  reserveAttemptMock.mockResolvedValue({ allowed: true, remaining: [9, 4] })
  settleSuccessMock.mockResolvedValue(true)
  findUniqueMock.mockResolvedValue(user(false))
  verifyPasswordMock.mockResolvedValue(true)
  verifySecondFactorMock.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('step-up policy', () => {
  // 所有者 2026-11-18 裁定的四行。改这张表等于改产品策略, 不是重构
  it('is the table the owner signed off', () => {
    expect(STEP_UP_POLICY).toEqual({
      'password.change': { password: 'required', secondFactor: 'never' },
      'email.change': { password: 'required', secondFactor: 'if-enabled' },
      'twoFactor.enroll': { password: 'required', secondFactor: 'never' },
      'twoFactor.disable': { password: 'never', secondFactor: 'required' }
    })
  })
})

describe('requireStepUp: password', () => {
  it('passes with the right password and settles the password budget', async () => {
    const result = await requireStepUp(
      7,
      'password.change',
      { currentPassword: 'hunter2a' },
      ctx
    )

    expect(result).toEqual({
      ok: true,
      passed: { uid: 7, action: 'password.change' }
    })
    const [dims] = reserveAttemptMock.mock.calls[0]
    expect(dims.map((dim: { key: string }) => dim.key)).toEqual([
      'auth:stepup:pw:uid:7',
      expect.stringMatching(/^auth:stepup:pw:uid-ip:7:[0-9a-f]{64}$/)
    ])
    expect(verifyPasswordMock).toHaveBeenCalledExactlyOnceWith(
      'hunter2a',
      'stored-hash'
    )
    expect(settleSuccessMock).toHaveBeenCalledExactlyOnceWith(dims)
  })

  it('reserves the budget before reading the credential and before hashing', async () => {
    await requireStepUp(7, 'password.change', { currentPassword: 'x' }, ctx)

    const order = [reserveAttemptMock, findUniqueMock, verifyPasswordMock].map(
      (mock) => mock.mock.invocationCallOrder[0]
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it.each([[undefined], ['']])(
    'asks for the password (%j) without charging anything',
    async (currentPassword) => {
      await expect(
        requireStepUp(7, 'password.change', { currentPassword }, ctx)
      ).resolves.toEqual({
        ok: false,
        reason: 'missing',
        message: '请输入当前密码'
      })

      expect(reserveAttemptMock).not.toHaveBeenCalled()
      expect(findUniqueMock).not.toHaveBeenCalled()
    }
  )

  it('refuses without reading or hashing when the budget is used up', async () => {
    reserveAttemptMock.mockResolvedValue({
      allowed: false,
      reason: 'exhausted',
      dimension: 'auth:stepup:pw:uid:7'
    })

    await expect(
      requireStepUp(7, 'password.change', { currentPassword: 'x' }, ctx)
    ).resolves.toEqual({
      ok: false,
      reason: 'locked',
      message: '密码尝试次数过多, 请 15 分钟后再试'
    })
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(verifyPasswordMock).not.toHaveBeenCalled()
  })

  it('fails closed when the budget cannot be reserved', async () => {
    reserveAttemptMock.mockRejectedValue(new Error('redis unavailable'))

    await expect(
      requireStepUp(7, 'password.change', { currentPassword: 'x' }, ctx)
    ).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      message: '验证服务暂不可用, 请稍后重试'
    })
    expect(verifyPasswordMock).not.toHaveBeenCalled()
  })

  it('keeps the reservation charged for a wrong password', async () => {
    verifyPasswordMock.mockResolvedValue(false)

    await expect(
      requireStepUp(7, 'password.change', { currentPassword: 'x' }, ctx)
    ).resolves.toEqual({
      ok: false,
      reason: 'invalid',
      message: '当前密码输入错误'
    })
    expect(settleSuccessMock).not.toHaveBeenCalled()
  })

  it('still passes when the counters cannot be cleared afterwards', async () => {
    settleSuccessMock.mockRejectedValue(new Error('redis unavailable'))

    await expect(
      requireStepUp(7, 'password.change', { currentPassword: 'x' }, ctx)
    ).resolves.toMatchObject({ ok: true })
  })

  it('rejects a session whose user row is gone', async () => {
    findUniqueMock.mockResolvedValue(null)

    await expect(
      requireStepUp(7, 'password.change', { currentPassword: 'x' }, ctx)
    ).resolves.toEqual({ ok: false, reason: 'invalid', message: '用户不存在' })
    expect(verifyPasswordMock).not.toHaveBeenCalled()
  })

  it('never asks for a second factor where the policy says never', async () => {
    findUniqueMock.mockResolvedValue(user(true))

    for (const action of ['password.change', 'twoFactor.enroll'] as const) {
      await expect(
        requireStepUp(7, action, { currentPassword: 'x' }, ctx)
      ).resolves.toMatchObject({ ok: true, passed: { action } })
    }
    expect(verifySecondFactorMock).not.toHaveBeenCalled()
  })
})

describe('requireStepUp: email.change (password, plus a second factor if 2FA is on)', () => {
  const proof = { currentPassword: 'x', totp: '123456' }

  it('needs only the password while 2FA is off', async () => {
    await expect(
      requireStepUp(7, 'email.change', { currentPassword: 'x' }, ctx)
    ).resolves.toMatchObject({ ok: true })
    expect(verifySecondFactorMock).not.toHaveBeenCalled()
  })

  it('needs both once 2FA is on, password first', async () => {
    findUniqueMock.mockResolvedValue(user(true))

    await expect(
      requireStepUp(7, 'email.change', proof, ctx)
    ).resolves.toMatchObject({ ok: true })

    expect(verifySecondFactorMock).toHaveBeenCalledExactlyOnceWith(
      7,
      { kind: 'totp', code: '123456' },
      ctx
    )
    expect(verifyPasswordMock.mock.invocationCallOrder[0]).toBeLessThan(
      verifySecondFactorMock.mock.invocationCallOrder[0]
    )
  })

  // 开了 2FA 不能把门槛降成只验一个 6 位数
  it('does not accept a correct second factor in place of the password', async () => {
    findUniqueMock.mockResolvedValue(user(true))

    await expect(
      requireStepUp(7, 'email.change', { totp: '123456' }, ctx)
    ).resolves.toMatchObject({ ok: false, reason: 'missing' })

    verifyPasswordMock.mockResolvedValue(false)
    await expect(requireStepUp(7, 'email.change', proof, ctx)).resolves.toEqual(
      {
        ok: false,
        reason: 'invalid',
        message: '当前密码输入错误'
      }
    )
    // 密码不对时不看第二因子: 不消耗它的额度, 也不透露它对不对
    expect(verifySecondFactorMock).not.toHaveBeenCalled()
  })

  it.each([[{}], [{ totp: '', backupCode: '' }]])(
    'asks for the second factor (%j) after the password has passed',
    async (secondFactor) => {
      findUniqueMock.mockResolvedValue(user(true))

      await expect(
        requireStepUp(
          7,
          'email.change',
          { currentPassword: 'x', ...secondFactor },
          ctx
        )
      ).resolves.toEqual({
        ok: false,
        reason: 'missing',
        message: '请输入 2FA 验证码'
      })
      expect(settleSuccessMock).toHaveBeenCalledTimes(1)
      expect(verifySecondFactorMock).not.toHaveBeenCalled()
    }
  )

  it('takes a backup code as the second factor and hands it on, still unused', async () => {
    findUniqueMock.mockResolvedValue(user(true))

    const result = await requireStepUp(
      7,
      'email.change',
      { currentPassword: 'x', totp: '', backupCode: '654321' },
      ctx
    )

    expect(verifySecondFactorMock).toHaveBeenCalledWith(
      7,
      { kind: 'backup', code: '654321' },
      ctx
    )
    expect(result).toEqual({
      ok: true,
      passed: { uid: 7, action: 'email.change', backupCode: '654321' }
    })
    expect(consumeBackupCodeMock).not.toHaveBeenCalled()
  })

  it('carries no backup code when the proof was a TOTP code or none was needed', async () => {
    findUniqueMock.mockResolvedValue(user(true))
    const withTotp = await requireStepUp(7, 'email.change', proof, ctx)
    findUniqueMock.mockResolvedValue(user(false))
    const passwordOnly = await requireStepUp(
      7,
      'email.change',
      { currentPassword: 'x', backupCode: '654321' },
      ctx
    )

    expect(withTotp).toEqual({
      ok: true,
      passed: { uid: 7, action: 'email.change' }
    })
    // 没启用 2FA 的账号用不着第二因子: 顺手带来的备份码不往下传
    expect(passwordOnly).toEqual({
      ok: true,
      passed: { uid: 7, action: 'email.change' }
    })
  })

  it.each([
    ['invalid', '2FA 验证码无效'],
    ['replayed', '该验证码已经使用过, 请等身份验证器显示新的验证码后再试'],
    ['locked', '验证尝试次数过多, 请 15 分钟后再试'],
    ['unavailable', '验证服务暂不可用, 请稍后重试']
  ] as const)('reports a second factor that is %s', async (reason, message) => {
    findUniqueMock.mockResolvedValue(user(true))
    verifySecondFactorMock.mockResolvedValue({ ok: false, reason })

    await expect(requireStepUp(7, 'email.change', proof, ctx)).resolves.toEqual(
      { ok: false, reason, message }
    )
  })
})

describe('requireStepUp: twoFactor.disable (second factor only)', () => {
  it('does not involve the password at all', async () => {
    findUniqueMock.mockResolvedValue(user(true))

    await expect(
      requireStepUp(7, 'twoFactor.disable', { totp: '123456' }, ctx)
    ).resolves.toEqual({
      ok: true,
      passed: { uid: 7, action: 'twoFactor.disable' }
    })

    expect(reserveAttemptMock).not.toHaveBeenCalled()
    expect(verifyPasswordMock).not.toHaveBeenCalled()
  })

  it('rejects an account that has no 2FA to disable', async () => {
    await expect(
      requireStepUp(7, 'twoFactor.disable', { totp: '123456' }, ctx)
    ).resolves.toEqual({
      ok: false,
      reason: 'invalid',
      message: '用户未启用 2FA'
    })
    expect(verifySecondFactorMock).not.toHaveBeenCalled()
  })

  it('reads the credential outside any transaction', async () => {
    findUniqueMock.mockResolvedValue(user(true))

    await requireStepUp(7, 'twoFactor.disable', { backupCode: '654321' }, ctx)

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
  })
})

describe('consumeStepUpBackupCode', () => {
  const tx = { marker: 'tx' } as never

  it('uses the backup code up on the transaction of the change it authorized', async () => {
    findUniqueMock.mockResolvedValue(user(true))
    consumeBackupCodeMock.mockResolvedValueOnce(true).mockResolvedValue(false)
    const result = await requireStepUp(
      7,
      'twoFactor.disable',
      { backupCode: '654321' },
      ctx
    )
    if (!result.ok) {
      throw new Error('step-up should pass')
    }

    await expect(consumeStepUpBackupCode(result.passed, tx)).resolves.toBe(true)
    // 校验之后被别的请求先用掉了
    await expect(consumeStepUpBackupCode(result.passed, tx)).resolves.toBe(
      false
    )
    expect(consumeBackupCodeMock).toHaveBeenCalledWith(7, '654321', tx)
  })

  it('has nothing to do when the proof was not a backup code', async () => {
    findUniqueMock.mockResolvedValue(user(true))
    const result = await requireStepUp(
      7,
      'twoFactor.disable',
      { totp: '123456' },
      ctx
    )
    if (!result.ok) {
      throw new Error('step-up should pass')
    }

    await expect(consumeStepUpBackupCode(result.passed, tx)).resolves.toBe(true)
    expect(consumeBackupCodeMock).not.toHaveBeenCalled()
  })
})
