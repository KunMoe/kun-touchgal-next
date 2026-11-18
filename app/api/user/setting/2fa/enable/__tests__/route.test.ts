import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KUN_ROLE } from '~/constants/role'

// 确认启用 2FA 入口的可观察行为。边界用内存态假件, TOTP 用真实算出来的验证码
const fakes = await vi.hoisted(async () =>
  (
    await import('~/app/api/user/setting/__tests__/_credentialFakes')
  ).createCredentialFakes()
)

vi.mock('~/prisma/index', () => fakes.modules.prisma)
vi.mock('~/lib/redis', () => fakes.modules.redis)
vi.mock('~/server/auth/attemptBudget', () => fakes.modules.budget)
vi.mock('~/middleware/_verifyHeaderCookie', () => fakes.modules.session)

import { hashTwoFactorBackupCode } from '~/server/auth/twoFactorBackupCode'
import {
  FIXED_NOW,
  jsonRequest,
  makeUser,
  TOTP_SECRET,
  totpAt,
  wrongTotp
} from '~/app/api/user/setting/__tests__/_credentialFakes'
import { POST } from '~/app/api/user/setting/2fa/enable/route'

const { budget, db, kv, session } = fakes
const UID = 7
const NO_SECRET = '未找到 2FA 密钥, 请先生成 2FA 密钥'
const STATE_CHANGED = '当前 2FA 状态已变化，请刷新后重试'
const REPLAYED = '该验证码已经使用过, 请等身份验证器显示新的验证码后再试'
const currentStep = () => Math.floor(Date.now() / 30_000)

const post = (body: unknown) =>
  POST(
    jsonRequest('/api/user/setting/2fa/enable', body) as unknown as Parameters<
      typeof POST
    >[0]
  )

const read = async (response: Response) => response.json()

const expectEnabledWith = (backupCode: string[]) => {
  expect(backupCode).toHaveLength(10)
  for (const code of backupCode) {
    expect(code).toMatch(/^\d{10}$/)
  }
  const row = db.user(UID)
  expect(row?.enable_2fa).toBe(true)
  expect(row?.two_factor_secret).toBe(TOTP_SECRET)
  expect(row?.two_factor_backup).toEqual(
    backupCode.map(hashTwoFactorBackupCode)
  )
  for (const stored of row?.two_factor_backup ?? []) {
    expect(stored).toMatch(/^h1:[0-9a-f]{64}$/)
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  vi.stubEnv(
    'KUN_TWO_FACTOR_BACKUP_PEPPER',
    'test-only-two-factor-backup-pepper-1234567890'
  )
  fakes.reset()
  // save-secret 之后、确认之前的状态: 有待确认的密钥, 尚未启用
  db.insertUser(makeUser({ id: UID, two_factor_secret: TOTP_SECRET }))
  session.signIn(UID, KUN_ROLE.USER)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/user/setting/2fa/enable', () => {
  it.each([
    [{ token: '12345' }, '2FA 验证码必须为 6 位数字'],
    [{ token: 'abcdef' }, '2FA 验证码必须为 6 位数字'],
    // 缺字段时是 zod 的默认英文文案
    [{}, 'Invalid input: expected string, received undefined']
  ])(
    'rejects %j with the zod message without reading the DB',
    async (body, message) => {
      const response = await post(body)

      expect(await read(response)).toBe(message)
      expect(db.queries).toEqual([])
    }
  )

  it('parses the body before checking the session', async () => {
    session.signOut()

    const invalid = await post({ token: '1' })
    const valid = await post({ token: totpAt(TOTP_SECRET) })

    expect(await read(invalid)).toBe('2FA 验证码必须为 6 位数字')
    expect(await read(valid)).toBe('用户未登录')
    expect(db.queries).toEqual([])
  })

  it('asks for a secret first when the row has none or is missing', async () => {
    db.patchUser(UID, { two_factor_secret: '' })
    const noSecret = await post({ token: totpAt(TOTP_SECRET) })
    db.reset()
    const noRow = await post({ token: totpAt(TOTP_SECRET) })

    expect(await read(noSecret)).toBe(NO_SECRET)
    expect(await read(noRow)).toBe(NO_SECRET)
  })

  it('rejects a wrong code and leaves 2FA off', async () => {
    const response = await post({ token: wrongTotp(TOTP_SECRET) })

    expect(await read(response)).toBe('2FA 验证码无效')
    expect(db.user(UID)).toMatchObject({
      enable_2fa: false,
      two_factor_backup: []
    })
  })

  it('enables 2FA and returns 10 backup codes that are stored only as hashes', async () => {
    const response = await post({ token: totpAt(TOTP_SECRET) })
    const body = await read(response)

    expect(Object.keys(body)).toEqual(['backupCode'])
    expectEnabledWith(body.backupCode)
  })

  // X07-02: 已启用的账号再提交正确的验证码, 曾经会悄悄换发全部备份码
  it('refuses an account that already has 2FA on and keeps its backup codes', async () => {
    const first = await read(await post({ token: totpAt(TOTP_SECRET) }))
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 30_000))

    const second = await read(await post({ token: totpAt(TOTP_SECRET) }))

    expect(second).toBe(STATE_CHANGED)
    expectEnabledWith(first.backupCode)
  })

  // 校验的是甲密钥, 写入时库里已经换成乙密钥: 不能把 2FA 绑到没验证过的密钥上
  it('refuses when the pending secret is replaced between the check and the write', async () => {
    db.interceptNextWrite(() => {
      db.patchUser(UID, { two_factor_secret: 'KRSXG5CTMVRXEZLU' })
    })

    const response = await post({ token: totpAt(TOTP_SECRET) })

    expect(await read(response)).toBe(STATE_CHANGED)
    expect(db.user(UID)).toMatchObject({
      enable_2fa: false,
      two_factor_secret: 'KRSXG5CTMVRXEZLU',
      two_factor_backup: []
    })
  })

  // P07-06: 跨步长到达的正确验证码不再被拒; 再远一步仍然拒绝
  it.each([[-1], [1]])(
    'accepts the code of the adjacent 30 s step (%i)',
    async (offset) => {
      const body = await read(
        await post({ token: totpAt(TOTP_SECRET, offset) })
      )

      expectEnabledWith(body.backupCode)
    }
  )

  it.each([[-2], [2]])('rejects a code two steps away (%i)', async (offset) => {
    const response = await post({ token: totpAt(TOTP_SECRET, offset) })

    expect(await read(response)).toBe('2FA 验证码无效')
    expect(db.user(UID)?.enable_2fa).toBe(false)
  })

  // X07-05: 同一个时间步的验证码只认一次, 登记与登录、设置页的其它入口共用
  it('rejects a code whose time step was already used elsewhere', async () => {
    kv.put(`auth:totp:used:${UID}:${currentStep()}`, '1', 120)

    const response = await post({ token: totpAt(TOTP_SECRET) })

    expect(await read(response)).toBe(REPLAYED)
    expect(db.user(UID)?.enable_2fa).toBe(false)
  })

  it('records the time step it accepted for two minutes', async () => {
    await post({ token: totpAt(TOTP_SECRET, -1) })

    expect(kv.get(`auth:totp:used:${UID}:${currentStep() - 1}`)).toEqual({
      value: '1',
      ttl: 120
    })
  })

  it('locks after ten wrong codes, even for a correct one', async () => {
    const wrong = wrongTotp(TOTP_SECRET)
    for (let i = 0; i < 10; i++) {
      expect(await read(await post({ token: wrong }))).toBe('2FA 验证码无效')
    }

    const response = await post({ token: totpAt(TOTP_SECRET) })

    expect(await read(response)).toBe('验证尝试次数过多, 请 15 分钟后再试')
    expect(db.user(UID)?.enable_2fa).toBe(false)
  })

  it('forgives earlier wrong codes once a correct one arrives', async () => {
    const wrong = wrongTotp(TOTP_SECRET)
    for (let i = 0; i < 3; i++) {
      await post({ token: wrong })
    }
    expect(budget.counts.get(`auth:stepup:2fa:uid:${UID}`)).toBe(3)

    const body = await read(await post({ token: totpAt(TOTP_SECRET) }))

    expectEnabledWith(body.backupCode)
    expect([...budget.counts.keys()]).toEqual([])
  })

  it('fails closed when attempts cannot be counted', async () => {
    budget.failNext()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await post({ token: totpAt(TOTP_SECRET) })

    expect(await read(response)).toBe('验证服务暂不可用, 请稍后重试')
    expect(db.user(UID)?.enable_2fa).toBe(false)
  })
})
