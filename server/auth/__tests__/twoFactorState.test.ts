import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = await vi.hoisted(async () =>
  (
    await import('~/app/api/user/setting/__tests__/_credentialFakes')
  ).createCredentialFakes()
)

const { verifyEnrollmentCodeMock } = vi.hoisted(() => ({
  verifyEnrollmentCodeMock: vi.fn()
}))

vi.mock('~/prisma/index', () => fakes.modules.prisma)

// 密钥与备份码的生成用真的, 只把「验证码对不对」换成可控的
vi.mock('~/server/auth/secondFactor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/auth/secondFactor')>()),
  verifyEnrollmentCode: verifyEnrollmentCodeMock
}))

vi.mock('~/lib/redis', () => ({}))
vi.mock('~/server/auth/attemptBudget', () => ({}))

import {
  makeUser,
  TOTP_SECRET
} from '~/app/api/user/setting/__tests__/_credentialFakes'
import {
  beginEnrollment,
  confirmEnrollment,
  disableTwoFactor,
  TWO_FACTOR_STATE_CHANGED
} from '~/server/auth/twoFactorState'
import { hashTwoFactorBackupCode } from '~/server/auth/twoFactorBackupCode'
import type { StepUpPassed } from '~/server/auth/stepUp'

// 品牌值只有 requireStepUp 造得出来; 这里测的是它之后的状态迁移
const passed = <A extends 'twoFactor.enroll' | 'twoFactor.disable'>(
  action: A
) => ({ uid: 7, action }) as StepUpPassed<A>

const ctx = { ip: '203.0.113.8' }

beforeEach(() => {
  vi.resetAllMocks()
  fakes.reset()
  vi.stubEnv(
    'KUN_TWO_FACTOR_BACKUP_PEPPER',
    'test-only-two-factor-backup-pepper-1234567890'
  )
  verifyEnrollmentCodeMock.mockResolvedValue({ ok: true })
})

describe('beginEnrollment', () => {
  it('stores a fresh pending secret and clears stale backup codes', async () => {
    fakes.db.insertUser(
      makeUser({
        two_factor_secret: 'OLDSECRETOLDSECR',
        two_factor_backup: ['x']
      })
    )

    const key = await beginEnrollment(passed('twoFactor.enroll'))

    expect(key).toEqual({
      secret: expect.stringMatching(/^[A-Z2-7]{16}$/),
      authUrl: expect.stringContaining('otpauth://totp/')
    })
    expect(fakes.db.user(7)).toMatchObject({
      enable_2fa: false,
      two_factor_secret: (key as { secret: string }).secret,
      two_factor_backup: []
    })
    expect((key as { secret: string }).secret).not.toBe('OLDSECRETOLDSECR')
  })

  it('refuses to replace the secret of an account that already has 2FA on', async () => {
    fakes.db.insertUser(
      makeUser({ enable_2fa: true, two_factor_secret: TOTP_SECRET })
    )

    await expect(beginEnrollment(passed('twoFactor.enroll'))).resolves.toBe(
      '请先关闭现有 2FA 后再重新设置'
    )
    expect(fakes.db.user(7)?.two_factor_secret).toBe(TOTP_SECRET)
  })

  it('does not overwrite when 2FA is switched on between the read and the write', async () => {
    fakes.db.insertUser(makeUser())
    fakes.db.interceptNextWrite(() => {
      fakes.db.patchUser(7, {
        enable_2fa: true,
        two_factor_secret: TOTP_SECRET
      })
    })

    await expect(beginEnrollment(passed('twoFactor.enroll'))).resolves.toBe(
      TWO_FACTOR_STATE_CHANGED
    )
    expect(fakes.db.user(7)).toMatchObject({
      enable_2fa: true,
      two_factor_secret: TOTP_SECRET
    })
  })

  it('reports a missing user', async () => {
    await expect(beginEnrollment(passed('twoFactor.enroll'))).resolves.toBe(
      '用户不存在'
    )
  })
})

describe('confirmEnrollment', () => {
  it('switches 2FA on and hands out backup codes stored only as hashes', async () => {
    fakes.db.insertUser(makeUser({ two_factor_secret: TOTP_SECRET }))

    const result = await confirmEnrollment(7, '123456', ctx)

    const { backupCode } = result as { backupCode: string[] }
    expect(backupCode).toHaveLength(10)
    expect(fakes.db.user(7)).toMatchObject({
      enable_2fa: true,
      two_factor_secret: TOTP_SECRET,
      two_factor_backup: backupCode.map(hashTwoFactorBackupCode)
    })
    expect(verifyEnrollmentCodeMock).toHaveBeenCalledExactlyOnceWith(
      7,
      TOTP_SECRET,
      '123456',
      ctx
    )
  })

  it('asks for a secret first when none is pending', async () => {
    fakes.db.insertUser(makeUser())

    await expect(confirmEnrollment(7, '123456', ctx)).resolves.toBe(
      '未找到 2FA 密钥, 请先生成 2FA 密钥'
    )
    expect(verifyEnrollmentCodeMock).not.toHaveBeenCalled()
  })

  // X07-02: 已启用的账号再提交一个正确的验证码, 曾经会悄悄换发全部备份码
  it('refuses an account that already has 2FA on and leaves its backup codes alone', async () => {
    fakes.db.insertUser(
      makeUser({
        enable_2fa: true,
        two_factor_secret: TOTP_SECRET,
        two_factor_backup: ['h1:existing']
      })
    )

    await expect(confirmEnrollment(7, '123456', ctx)).resolves.toBe(
      TWO_FACTOR_STATE_CHANGED
    )
    expect(fakes.db.user(7)?.two_factor_backup).toEqual(['h1:existing'])
    expect(verifyEnrollmentCodeMock).not.toHaveBeenCalled()
  })

  // 校验的是甲密钥, 写入时库里已经是乙密钥: 不能把 2FA 绑到一把没验证过的密钥上
  it('refuses when the pending secret is replaced between the check and the write', async () => {
    fakes.db.insertUser(makeUser({ two_factor_secret: TOTP_SECRET }))
    verifyEnrollmentCodeMock.mockImplementation(async () => {
      fakes.db.patchUser(7, { two_factor_secret: 'KRSXG5CTMVRXEZLU' })
      return { ok: true }
    })

    await expect(confirmEnrollment(7, '123456', ctx)).resolves.toBe(
      TWO_FACTOR_STATE_CHANGED
    )
    expect(fakes.db.user(7)).toMatchObject({
      enable_2fa: false,
      two_factor_secret: 'KRSXG5CTMVRXEZLU',
      two_factor_backup: []
    })
  })

  it('refuses when another request enables 2FA between the check and the write', async () => {
    fakes.db.insertUser(makeUser({ two_factor_secret: TOTP_SECRET }))
    verifyEnrollmentCodeMock.mockImplementation(async () => {
      fakes.db.patchUser(7, {
        enable_2fa: true,
        two_factor_backup: ['h1:first-winner']
      })
      return { ok: true }
    })

    await expect(confirmEnrollment(7, '123456', ctx)).resolves.toBe(
      TWO_FACTOR_STATE_CHANGED
    )
    expect(fakes.db.user(7)?.two_factor_backup).toEqual(['h1:first-winner'])
  })

  it.each([
    ['invalid', '2FA 验证码无效'],
    ['replayed', '该验证码已经使用过, 请等身份验证器显示新的验证码后再试'],
    ['locked', '验证尝试次数过多, 请 15 分钟后再试'],
    ['unavailable', '验证服务暂不可用, 请稍后重试']
  ])('keeps 2FA off when the code is %s', async (reason, message) => {
    fakes.db.insertUser(makeUser({ two_factor_secret: TOTP_SECRET }))
    verifyEnrollmentCodeMock.mockResolvedValue({ ok: false, reason })

    await expect(confirmEnrollment(7, '123456', ctx)).resolves.toBe(message)
    expect(fakes.db.user(7)).toMatchObject({
      enable_2fa: false,
      two_factor_backup: []
    })
  })
})

describe('disableTwoFactor', () => {
  const enabled = () =>
    makeUser({
      enable_2fa: true,
      two_factor_secret: TOTP_SECRET,
      two_factor_backup: ['h1:a', 'h1:b']
    })

  it('clears the secret and the backup codes of an account with 2FA on', async () => {
    fakes.db.insertUser(enabled())

    await expect(disableTwoFactor(passed('twoFactor.disable'))).resolves.toBe(
      true
    )
    expect(fakes.db.user(7)).toMatchObject({
      enable_2fa: false,
      two_factor_secret: '',
      two_factor_backup: []
    })
  })

  it('reports false and writes nothing when 2FA is not on', async () => {
    fakes.db.insertUser(makeUser({ two_factor_secret: TOTP_SECRET }))

    await expect(disableTwoFactor(passed('twoFactor.disable'))).resolves.toBe(
      false
    )
    // 待确认的密钥不归「关闭」管
    expect(fakes.db.user(7)?.two_factor_secret).toBe(TOTP_SECRET)
  })

  it('lets an admin override target another user, inside the given transaction', async () => {
    fakes.db.insertUser(enabled())
    fakes.db.insertUser(makeUser({ id: 1, name: 'admin', email: 'a@x.io' }))

    await expect(
      fakes.db.client.$transaction(async (tx: never) => {
        await disableTwoFactor(
          { kind: 'admin-override', adminUid: 1, uid: 7 },
          tx
        )
        throw new Error('rollback')
      })
    ).rejects.toThrow('rollback')

    // 写在事务里: 回滚后 2FA 仍开着
    expect(fakes.db.user(7)?.enable_2fa).toBe(true)
  })
})
