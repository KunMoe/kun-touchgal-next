import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KUN_ROLE } from '~/constants/role'

// 关闭 2FA 入口的可观察行为。边界用内存态假件 (事务假件记录提交 / 回滚),
// TOTP 用真实算出来的验证码, 备份码走真实的哈希与消费语句
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
import { POST as enable } from '~/app/api/user/setting/2fa/enable/route'
import { POST } from '~/app/api/user/setting/2fa/disable/route'

const { budget, db, session } = fakes
const UID = 7
const BACKUP_CODES = ['111111', '222222']
const DISABLED = { success: true, message: '2FA 已禁用' }
const INVALID = '2FA 验证码无效'
const LOCKED = '验证尝试次数过多, 请 15 分钟后再试'

const post = (body: unknown, ip = '203.0.113.8') =>
  POST(
    jsonRequest('/api/user/setting/2fa/disable', body, {
      'x-real-ip': ip
    }) as unknown as Parameters<typeof POST>[0]
  )

const read = async (response: Response) => response.json()

const enabledRow = () => ({
  enable_2fa: true,
  two_factor_secret: TOTP_SECRET,
  two_factor_backup: BACKUP_CODES.map(hashTwoFactorBackupCode)
})

const expectDisabled = () =>
  expect(db.user(UID)).toMatchObject({
    enable_2fa: false,
    two_factor_secret: '',
    two_factor_backup: []
  })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  vi.stubEnv(
    'KUN_TWO_FACTOR_BACKUP_PEPPER',
    'test-only-two-factor-backup-pepper-1234567890'
  )
  fakes.reset()
  db.insertUser(makeUser({ id: UID, ...enabledRow() }))
  session.signIn(UID, KUN_ROLE.USER)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/user/setting/2fa/disable', () => {
  it('checks the session before parsing the body (owner ruling)', async () => {
    session.signOut()

    const response = await post({ token: '1' })

    expect(await read(response)).toBe('用户未登录')
    expect(db.queries).toEqual([])
  })

  it('rejects a malformed code without reading the DB', async () => {
    const response = await post({ token: '12', isBackupCode: false })

    expect(await read(response)).toBe('2FA 验证码必须为 6 位数字')
    expect(db.queries).toEqual([])
  })

  it.each([
    [
      { token: '12345678', isBackupCode: true },
      '备用验证码必须为 6 位或 10 位数字'
    ],
    // 身份验证器的验证码恒为 6 位: 10 位只在声明为备用验证码时才收
    [{ token: '1234567890', isBackupCode: false }, '2FA 验证码必须为 6 位数字'],
    [
      { token: 'abcdef', isBackupCode: true },
      '备用验证码必须为 6 位或 10 位数字'
    ]
  ])('rejects %j without reading the DB', async (body, message) => {
    const response = await post(body)

    expect(await read(response)).toBe(message)
    expect(db.queries).toEqual([])
  })

  it('answers 用户未启用 2FA when there is nothing to disable', async () => {
    db.patchUser(UID, { enable_2fa: false })

    const response = await post({ token: totpAt(TOTP_SECRET) })

    expect(await read(response)).toBe('用户未启用 2FA')
    // 待确认的密钥不归这个入口管
    expect(db.user(UID)?.two_factor_secret).toBe(TOTP_SECRET)
  })

  it('answers 用户不存在 when the session user has no row', async () => {
    db.reset()

    const response = await post({ token: totpAt(TOTP_SECRET) })

    expect(await read(response)).toBe('用户不存在')
  })

  describe('with a TOTP code', () => {
    it('clears the flag, the secret and the backup codes on a correct code', async () => {
      const response = await post({ token: totpAt(TOTP_SECRET) })

      expect(await read(response)).toEqual(DISABLED)
      expectDisabled()
      expect(db.transactions).toEqual([{ committed: true }])
    })

    it('rejects a wrong code and leaves the row unchanged', async () => {
      const response = await post({ token: wrongTotp(TOTP_SECRET) })

      expect(await read(response)).toBe(INVALID)
      expect(db.user(UID)).toMatchObject(enabledRow())
      // 二次验证没过就不开事务
      expect(db.transactions).toEqual([])
    })

    // 启用了但密钥是空的 (坏数据): 没有哪个验证码能对上, 仍可用备份码关闭
    it('treats every code as wrong when the stored secret is empty', async () => {
      db.patchUser(UID, { two_factor_secret: '' })

      const viaTotp = await post({ token: totpAt(TOTP_SECRET) })
      expect(await read(viaTotp)).toBe(INVALID)
      expect(db.user(UID)?.enable_2fa).toBe(true)

      const viaBackup = await post({
        token: BACKUP_CODES[0],
        isBackupCode: true
      })
      expect(await read(viaBackup)).toEqual(DISABLED)
    })

    // 关闭是条件写入: 验证通过之后、写入之前, 另一个请求已经把 2FA 关掉了
    it('reports a changed state when 2FA is switched off by another request first', async () => {
      db.interceptNextWrite(() => {
        db.patchUser(UID, {
          enable_2fa: false,
          two_factor_secret: '',
          two_factor_backup: []
        })
      })

      const response = await post({ token: totpAt(TOTP_SECRET) })

      expect(await read(response)).toBe('当前 2FA 状态已变化，请刷新后重试')
      expect(db.transactions).toEqual([{ committed: false }])
    })

    // P07-06: 跨步长到达的正确验证码不再被拒
    it.each([[-1], [1]])(
      'accepts the code of the adjacent 30 s step (%i)',
      async (offset) => {
        const response = await post({ token: totpAt(TOTP_SECRET, offset) })

        expect(await read(response)).toEqual(DISABLED)
        expectDisabled()
      }
    )

    it.each([[-2], [2]])(
      'rejects a code two steps away (%i)',
      async (offset) => {
        const response = await post({ token: totpAt(TOTP_SECRET, offset) })

        expect(await read(response)).toBe(INVALID)
        expect(db.user(UID)).toMatchObject(enabledRow())
      }
    )

    // X07-05: 刚用来启用 2FA 的那个码, 不能在同一个时间步里再拿来关闭
    it('rejects a code that the enable route already used in the same step', async () => {
      db.patchUser(UID, { enable_2fa: false, two_factor_backup: [] })
      const code = totpAt(TOTP_SECRET)
      const enabled = await enable(
        jsonRequest('/api/user/setting/2fa/enable', {
          token: code
        }) as unknown as Parameters<typeof enable>[0]
      )
      expect((await read(enabled)).backupCode).toHaveLength(10)

      const replayed = await post({ token: code })

      expect(await read(replayed)).toBe(
        '该验证码已经使用过, 请等身份验证器显示新的验证码后再试'
      )
      expect(db.user(UID)?.enable_2fa).toBe(true)

      // 下一个时间步的新码可以
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 30_000))
      const fresh = await post({ token: totpAt(TOTP_SECRET) })
      expect(await read(fresh)).toEqual(DISABLED)
    })
  })

  describe('with a backup code', () => {
    it('consumes the code and disables 2FA in one committed transaction', async () => {
      const response = await post({
        token: BACKUP_CODES[1],
        isBackupCode: true
      })

      expect(await read(response)).toEqual(DISABLED)
      expectDisabled()
      expect(db.transactions).toEqual([{ committed: true }])
      // 先消费, 后关闭
      const writes = db.queries.filter((query) => !query.endsWith('findUnique'))
      expect(writes).toEqual(['$executeRaw', 'user.updateMany'])
    })

    // 新发的备份码是 10 位, 存量的 6 位照常可用
    it('accepts a 10-digit backup code next to the 6-digit ones', async () => {
      db.patchUser(UID, {
        two_factor_backup: [
          hashTwoFactorBackupCode('0123456789'),
          hashTwoFactorBackupCode(BACKUP_CODES[0])
        ]
      })

      const response = await post({ token: '0123456789', isBackupCode: true })

      expect(await read(response)).toEqual(DISABLED)
      expectDisabled()
    })

    it('rejects a wrong code and keeps every backup code', async () => {
      const response = await post({ token: '999999', isBackupCode: true })

      expect(await read(response)).toBe(INVALID)
      expect(db.user(UID)).toMatchObject(enabledRow())
      expect(db.transactions).toEqual([])
    })

    // 校验通过之后、事务里消费之前, 同一个备份码被另一个请求先用掉了 (例如拿去登录)
    it('refuses when the backup code is used by another request in the meantime', async () => {
      db.interceptNextWrite(() => {
        db.patchUser(UID, {
          two_factor_backup: [hashTwoFactorBackupCode(BACKUP_CODES[1])]
        })
      })

      const response = await post({
        token: BACKUP_CODES[0],
        isBackupCode: true
      })

      expect(await read(response)).toBe(INVALID)
      expect(db.user(UID)).toMatchObject({
        enable_2fa: true,
        two_factor_backup: [hashTwoFactorBackupCode(BACKUP_CODES[1])]
      })
      expect(db.transactions).toEqual([{ committed: false }])
    })

    it('does not accept a TOTP code sent as a backup code', async () => {
      const response = await post({
        token: totpAt(TOTP_SECRET),
        isBackupCode: true
      })

      expect(await read(response)).toBe(INVALID)
      expect(db.user(UID)).toMatchObject(enabledRow())
    })

    // 关闭这一步失败时, 已经消费的备份码要随事务一起回来
    it('gives the backup code back when disabling fails after the code was consumed', async () => {
      db.interceptNextWrite(() => {
        db.failNextWrite(new Error('connection lost'))
      })

      await expect(
        post({ token: BACKUP_CODES[0], isBackupCode: true })
      ).rejects.toThrow('connection lost')

      expect(db.user(UID)).toMatchObject(enabledRow())
      expect(db.transactions).toEqual([{ committed: false }])
    })
  })

  // H5 的计数那一半: 这里曾经可以无限次猜, 6 位备份码约半小时就能撞中一个
  describe('attempt budget', () => {
    it('locks one IP after five wrong codes, whatever their kind', async () => {
      for (let i = 0; i < 3; i++) {
        await post({ token: wrongTotp(TOTP_SECRET) })
      }
      for (let i = 0; i < 2; i++) {
        await post({ token: String(900000 + i), isBackupCode: true })
      }

      const viaTotp = await post({ token: totpAt(TOTP_SECRET) })
      const viaBackup = await post({
        token: BACKUP_CODES[0],
        isBackupCode: true
      })

      expect(await read(viaTotp)).toBe(LOCKED)
      expect(await read(viaBackup)).toBe(LOCKED)
      expect(db.user(UID)).toMatchObject(enabledRow())
    })

    it('locks the account after ten wrong codes across IPs', async () => {
      for (let i = 0; i < 10; i++) {
        const response = await post(
          { token: String(900000 + i), isBackupCode: true },
          `203.0.113.${i}`
        )
        expect(await read(response)).toBe(INVALID)
      }

      const response = await post(
        { token: BACKUP_CODES[0], isBackupCode: true },
        '203.0.113.99'
      )

      expect(await read(response)).toBe(LOCKED)
      expect(db.user(UID)).toMatchObject(enabledRow())
    })

    it('forgives earlier wrong codes once a correct one arrives', async () => {
      for (let i = 0; i < 3; i++) {
        await post({ token: wrongTotp(TOTP_SECRET) })
      }
      expect(budget.counts.get(`auth:stepup:2fa:uid:${UID}`)).toBe(3)

      const response = await post({ token: totpAt(TOTP_SECRET) })

      expect(await read(response)).toEqual(DISABLED)
      expect([...budget.counts.keys()]).toEqual([])
    })

    it('fails closed when attempts cannot be counted', async () => {
      budget.failNext()
      vi.spyOn(console, 'error').mockImplementation(() => {})

      const response = await post({ token: totpAt(TOTP_SECRET) })

      expect(await read(response)).toBe('验证服务暂不可用, 请稍后重试')
      expect(db.user(UID)).toMatchObject(enabledRow())
    })

    // 被锁之后的请求不该再占一个数据库事务 (Redis 往返都在事务之外)
    it('opens no transaction for a locked-out request', async () => {
      for (let i = 0; i < 5; i++) {
        await post({ token: String(900000 + i), isBackupCode: true })
      }

      await post({ token: BACKUP_CODES[0], isBackupCode: true })

      expect(db.transactions).toEqual([])
    })
  })
})
