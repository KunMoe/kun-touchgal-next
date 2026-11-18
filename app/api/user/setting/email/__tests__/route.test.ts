import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { createHash } from 'crypto'
import { KUN_ROLE } from '~/constants/role'

// 改邮箱入口的可观察行为 (仍按现状钉住的已知问题, 用例名带 [current: ...])。
// 只假掉边界 (库 / KV / 尝试预算 / 会话 / 邮件), 校验、口令、TOTP、验证码与 _emailChange 都跑真实现
const fakes = await vi.hoisted(async () =>
  (
    await import('~/app/api/user/setting/__tests__/_credentialFakes')
  ).createCredentialFakes()
)

vi.mock('~/prisma/index', () => fakes.modules.prisma)
vi.mock('~/lib/redis', () => fakes.modules.redis)
vi.mock('~/server/auth/attemptBudget', () => fakes.modules.budget)
vi.mock('~/middleware/_verifyHeaderCookie', () => fakes.modules.session)

import { hashPassword } from '~/server/auth/algorithm'
import { hashTwoFactorBackupCode } from '~/server/auth/twoFactorBackupCode'
import {
  FAKE_SITE_ADDRESS,
  FIXED_NOW,
  jsonRequest,
  makeUser,
  TOTP_SECRET,
  totpAt,
  wrongTotp
} from '~/app/api/user/setting/__tests__/_credentialFakes'
import { POST } from '~/app/api/user/setting/email/route'

const { budget, db, kv, mail, session } = fakes
const UID = 7
const OLD_EMAIL = 'old@example.com'
const NEW_EMAIL = 'new@example.com'
const TAKEN_EMAIL = 'taken@example.com'
const PASSWORD = 'kunpass123'
const WRONG_PASSWORD = 'wrongpass456'
const CODE = 'AbC1234'
const NOTICE_FAILED = '发送旧邮箱安全通知失败, 请稍后重试'
const CODE_INVALID = '您的验证码无效, 请重新输入'
const REPLAYED = '该验证码已经使用过, 请等身份验证器显示新的验证码后再试'
const BACKUP_CODES = ['111111', '222222']
const ARGON2_HEAVY_TIMEOUT = 60_000

let passwordHash = ''

type EmailBody = {
  email?: string
  code?: string
  currentPassword?: string
  totp?: string
  backupCode?: string
}

const post = (body: EmailBody, headers: Record<string, string> = {}) =>
  POST(
    jsonRequest('/api/user/setting/email', body, {
      'x-real-ip': '203.0.113.8',
      ...headers
    }) as unknown as Parameters<typeof POST>[0]
  )

const read = async (response: Response) => response.json()

const passwordBody = (overrides: EmailBody = {}): EmailBody => ({
  email: NEW_EMAIL,
  code: CODE,
  currentPassword: PASSWORD,
  ...overrides
})

// 启用了 2FA 的账号: 当前密码 + 第二因子
const totpBody = (overrides: EmailBody = {}): EmailBody => ({
  email: NEW_EMAIL,
  code: CODE,
  currentPassword: PASSWORD,
  totp: totpAt(TOTP_SECRET),
  ...overrides
})

const use2FA = () => {
  db.patchUser(UID, {
    enable_2fa: true,
    two_factor_secret: TOTP_SECRET,
    two_factor_backup: BACKUP_CODES.map(hashTwoFactorBackupCode)
  })
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD)
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  vi.stubEnv(
    'KUN_TWO_FACTOR_BACKUP_PEPPER',
    'test-only-two-factor-backup-pepper-1234567890'
  )
  fakes.reset()
  mail.install()
  db.insertUser(makeUser({ id: UID, email: OLD_EMAIL, password: passwordHash }))
  db.insertUser(makeUser({ id: 8, name: 'other', email: TAKEN_EMAIL }))
  kv.put(NEW_EMAIL, CODE, 600)
  session.signIn(UID, KUN_ROLE.USER)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/user/setting/email: request gates', () => {
  it.each([
    [{ email: 'not-an-email' }, '请输入合法的邮箱格式'],
    [{ code: 'abc' }, '邮箱验证码格式无效'],
    [{ totp: '12345' }, '2FA 验证码必须为 6 位数字'],
    [{ backupCode: '12345' }, '备用验证码必须为 6 位或 10 位数字'],
    [{ backupCode: '12345678' }, '备用验证码必须为 6 位或 10 位数字']
  ])(
    'returns the zod message for %j without reading the DB',
    async (overrides, message) => {
      const response = await post(passwordBody(overrides))

      expect(await read(response)).toBe(message)
      expect(db.queries).toEqual([])
      expect(kv.get(NEW_EMAIL)?.value).toBe(CODE)
    }
  )

  it('rejects an anonymous request without reading the DB', async () => {
    session.signOut()

    const response = await post(passwordBody())

    expect(await read(response)).toBe('用户未登录')
    expect(db.queries).toEqual([])
  })

  it('requires a client IP header without reading the DB', async () => {
    const response = await POST(
      jsonRequest(
        '/api/user/setting/email',
        passwordBody()
      ) as unknown as Parameters<typeof POST>[0]
    )

    expect(await read(response)).toBe('读取请求头失败')
    expect(db.queries).toEqual([])
  })

  it.each(['CF-Connecting-IP', 'x-forwarded-for', 'x-real-ip'])(
    'accepts %s as the client IP header',
    async (header) => {
      db.reset()

      const response = await POST(
        jsonRequest('/api/user/setting/email', passwordBody(), {
          [header]: '203.0.113.8'
        }) as unknown as Parameters<typeof POST>[0]
      )

      expect(await read(response)).toBe('用户不存在')
    }
  )

  it('answers 用户不存在 when the session user has no row', async () => {
    db.reset()

    const response = await post(passwordBody())

    expect(await read(response)).toBe('用户不存在')
  })

  it('rejects the current address', async () => {
    const response = await post(passwordBody({ email: OLD_EMAIL }))

    expect(await read(response)).toBe('新邮箱不能与当前邮箱相同')
  })

  it('rejects an address owned by another user', async () => {
    kv.put(TAKEN_EMAIL, CODE, 600)

    const response = await post(passwordBody({ email: TAKEN_EMAIL }))

    expect(await read(response)).toBe('该邮箱已被使用')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
  })

  it('[current: case-sensitive duplicate check] accepts a case variant of an address owned by another user', async () => {
    // 注册查重与登录都按大小写不敏感匹配邮箱, 这里是精确匹配, 库里也没有 lower(email) 唯一索引
    const variant = 'TAKEN@example.com'
    kv.put(variant, CODE, 600)

    const response = await post(passwordBody({ email: variant }))

    expect(await read(response)).toEqual({})
    expect(db.user(UID)?.email).toBe(variant)
    expect(db.user(8)?.email).toBe(TAKEN_EMAIL)
  })

  // P07-08: 查重曾排在身份证明之前, 只凭会话就能探测一个地址注册没有。现在被占地址与
  // 空闲地址在证明身份、并交出发往该地址的验证码之前, 回答逐字相同
  it('answers a taken and a free address alike until identity and the mailed code are proven', async () => {
    const ask = async (overrides: EmailBody) => [
      await read(await post({ code: CODE, ...overrides, email: TAKEN_EMAIL })),
      await read(await post({ code: CODE, ...overrides, email: NEW_EMAIL }))
    ]

    expect(await ask({})).toEqual(['请输入当前密码', '请输入当前密码'])
    expect(await ask({ currentPassword: WRONG_PASSWORD })).toEqual([
      '当前密码输入错误',
      '当前密码输入错误'
    ])
    use2FA()
    expect(await ask({ currentPassword: PASSWORD })).toEqual([
      '请输入 2FA 验证码',
      '请输入 2FA 验证码'
    ])

    // 身份已证明, 但没有发往被占地址的那封验证码 (它在地址主人的邮箱里)
    const proven = await post(totpBody({ email: TAKEN_EMAIL }))
    expect(await read(proven)).toBe(CODE_INVALID)
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
  })
})

describe('POST /api/user/setting/email: identity proof', () => {
  it('asks a password-only account for its password', async () => {
    const missing = await post(passwordBody({ currentPassword: undefined }))
    const empty = await post(passwordBody({ currentPassword: '   ' }))
    const wrong = await post(passwordBody({ currentPassword: WRONG_PASSWORD }))

    expect(await read(missing)).toBe('请输入当前密码')
    expect(await read(empty)).toBe('请输入当前密码')
    expect(await read(wrong)).toBe('当前密码输入错误')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
  })

  it('does not take a TOTP code in place of the password', async () => {
    db.patchUser(UID, { two_factor_secret: TOTP_SECRET })

    const response = await post(totpBody({ currentPassword: undefined }))

    expect(await read(response)).toBe('请输入当前密码')
  })

  it('needs only the password while 2FA is off, even if a code is sent along', async () => {
    const response = await post(passwordBody({ totp: '123456' }))

    expect(await read(response)).toEqual({})
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
  })

  // 曾经: 开了 2FA 的账号只验 TOTP, 等于把门槛从密码降成一个 6 位数
  it('asks a 2FA account for the password first, then for a second factor', async () => {
    use2FA()

    const totpOnly = await post(totpBody({ currentPassword: undefined }))
    const wrongPassword = await post(
      totpBody({ currentPassword: WRONG_PASSWORD })
    )
    const passwordOnly = await post(totpBody({ totp: undefined }))
    const emptyCode = await post(totpBody({ totp: '' }))
    const wrongCode = await post(totpBody({ totp: wrongTotp(TOTP_SECRET) }))

    expect(await read(totpOnly)).toBe('请输入当前密码')
    expect(await read(wrongPassword)).toBe('当前密码输入错误')
    expect(await read(passwordOnly)).toBe('请输入 2FA 验证码')
    expect(await read(emptyCode)).toBe('请输入 2FA 验证码')
    expect(await read(wrongCode)).toBe('2FA 验证码无效')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    expect(mail.outbox).toEqual([])
  })

  it('accepts a 2FA account with the password and a TOTP code', async () => {
    use2FA()

    const response = await post(totpBody())

    expect(await read(response)).toEqual({})
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
  })

  it('accepts a backup code as the second factor and uses it up', async () => {
    use2FA()

    const wrong = await post(totpBody({ totp: '', backupCode: '999999' }))
    const right = await post(
      totpBody({ totp: '', backupCode: BACKUP_CODES[0] })
    )

    expect(await read(wrong)).toBe('2FA 验证码无效')
    expect(await read(right)).toEqual({})
    expect(db.user(UID)).toMatchObject({
      email: NEW_EMAIL,
      two_factor_backup: [hashTwoFactorBackupCode(BACKUP_CODES[1])]
    })
  })

  // 启用了但密钥是空的 (坏数据): 没有哪个验证码能对上
  it('treats every TOTP code as wrong when the stored secret is empty', async () => {
    db.patchUser(UID, { enable_2fa: true, two_factor_secret: '' })

    const missing = await post(totpBody({ totp: undefined }))
    const given = await post(totpBody())

    expect(await read(missing)).toBe('请输入 2FA 验证码')
    expect(await read(given)).toBe('2FA 验证码无效')
  })

  // P07-06: 跨步长到达的正确验证码不再被拒
  it.each([[-1], [1]])(
    'accepts the TOTP code of the adjacent 30 s step (%i)',
    async (offset) => {
      use2FA()

      const response = await post(
        totpBody({ totp: totpAt(TOTP_SECRET, offset) })
      )

      expect(await read(response)).toEqual({})
    }
  )

  it.each([[-2], [2]])(
    'rejects a TOTP code two steps away (%i)',
    async (offset) => {
      use2FA()

      const response = await post(
        totpBody({ totp: totpAt(TOTP_SECRET, offset) })
      )

      expect(await read(response)).toBe('2FA 验证码无效')
      expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    }
  )

  // X07-05: 同一个时间步的验证码只认一次
  it('rejects the same TOTP code a second time within its step', async () => {
    use2FA()
    const code = totpAt(TOTP_SECRET)
    kv.put('third@example.com', CODE, 600)

    const first = await post(totpBody({ totp: code }))
    const second = await post(
      totpBody({ email: 'third@example.com', totp: code })
    )

    expect(await read(first)).toEqual({})
    expect(await read(second)).toBe(REPLAYED)
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
  })

  it('locks the second factor after five wrong codes from one IP, without touching the password bucket', async () => {
    use2FA()
    const wrong = wrongTotp(TOTP_SECRET)

    for (let i = 0; i < 5; i++) {
      expect(await read(await post(totpBody({ totp: wrong })))).toBe(
        '2FA 验证码无效'
      )
    }
    const response = await post(totpBody())

    expect(await read(response)).toBe('验证尝试次数过多, 请 15 分钟后再试')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    // 每次密码都对: 密码桶已结清, 只剩第二因子的计数
    expect(
      [...budget.counts.keys()].every((key) =>
        key.startsWith('auth:stepup:2fa:')
      )
    ).toBe(true)
  })

  it(
    'locks the password after five wrong guesses from one IP',
    async () => {
      for (let i = 0; i < 5; i++) {
        const response = await post(
          passwordBody({ currentPassword: `${WRONG_PASSWORD}${i}` })
        )
        expect(await read(response)).toBe('当前密码输入错误')
      }
      const response = await post(passwordBody())

      expect(await read(response)).toBe('密码尝试次数过多, 请 15 分钟后再试')
      expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    },
    ARGON2_HEAVY_TIMEOUT
  )

  it('fails closed when attempts cannot be counted', async () => {
    budget.failNext()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await post(passwordBody())

    expect(await read(response)).toBe('验证服务暂不可用, 请稍后重试')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
  })
})

describe('POST /api/user/setting/email: verification code', () => {
  it('does not consume the verification code when the identity proof fails', async () => {
    const response = await post(
      passwordBody({ currentPassword: WRONG_PASSWORD })
    )

    expect(await read(response)).toBe('当前密码输入错误')
    expect(kv.get(NEW_EMAIL)?.value).toBe(CODE)
    expect(mail.outbox).toEqual([])
  })

  it('checks the code stored under the bare new address after the proof', async () => {
    const wrong = await post(passwordBody({ code: 'Zzz9999' }))
    kv.entries.delete(NEW_EMAIL)
    const missing = await post(passwordBody())

    expect(await read(wrong)).toBe('您的验证码无效, 请重新输入')
    expect(await read(missing)).toBe('您的验证码无效, 请重新输入')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    expect(mail.outbox).toEqual([])
    expect(db.emailChanges()).toEqual([])
  })

  it('leaves the code in place after a wrong guess and compares case-insensitively', async () => {
    const wrong = await post(passwordBody({ code: 'Zzz9999' }))
    const caseFolded = await post(passwordBody({ code: CODE.toLowerCase() }))

    expect(await read(wrong)).toBe('您的验证码无效, 请重新输入')
    expect(await read(caseFolded)).toEqual({})
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
  })
})

describe('POST /api/user/setting/email: notice and commit', () => {
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex')
  const tokenIn = (text: string) =>
    text.match(/revert\?token=([A-Za-z0-9_-]+)/)?.[1] ?? ''

  it('notifies the old address with a revert link, then switches the email and records the change', async () => {
    let atSend: { email?: string; ledger: number } | undefined
    mail.onSend(() => {
      atSend = { email: db.user(UID)?.email, ledger: db.emailChanges().length }
    })

    const response = await post(passwordBody())

    expect(await read(response)).toEqual({})
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
    expect(kv.get(NEW_EMAIL)).toBeNull()
    // 通知发出那一刻库里还是旧地址, 台账也还没写: 发不出去就什么都不改
    expect(atSend).toEqual({ email: OLD_EMAIL, ledger: 0 })

    expect(mail.outbox).toHaveLength(1)
    const [notice] = mail.outbox
    const token = tokenIn(notice.plain)
    // 32 字节随机数的 base64url
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const link = `${FAKE_SITE_ADDRESS}/api/user/setting/email/revert?token=${token}`
    expect(notice.to).toEqual([OLD_EMAIL])
    expect(notice.html).toContain(`href="${link}"`)
    expect(notice.html).toContain(OLD_EMAIL)
    expect(notice.html).toContain(NEW_EMAIL)
    expect(notice.plain).toContain(link)

    // 库里只有令牌的哈希; 撤销状态不再放 Redis
    expect(db.emailChanges()).toEqual([
      {
        id: 1,
        user_id: UID,
        old_email: OLD_EMAIL,
        new_email: NEW_EMAIL,
        revert_token_hash: sha256(token),
        created: FIXED_NOW,
        expires: new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000),
        reverted: null
      }
    ])
    expect(kv.keys()).toEqual([])
    expect(db.transactions).toEqual([{ committed: true }])
  })

  it.each(['http-error', 'status-error', 'throw'] as const)(
    'fails closed when the old-address notice fails (%s)',
    async (mode) => {
      mail.setMode(mode)

      const response = await post(passwordBody())

      expect(await read(response)).toBe(NOTICE_FAILED)
      expect(mail.outbox).toHaveLength(1)
      expect(db.user(UID)?.email).toBe(OLD_EMAIL)
      expect(db.emailChanges()).toEqual([])
      expect(kv.get(NEW_EMAIL)?.value).toBe(CODE)
    }
  )

  it('reports a failed write and records nothing (unique violation)', async () => {
    // 另一个请求在检查与写入之间抢注了同一地址
    db.interceptNextWrite(() =>
      db.insertUser(makeUser({ id: 9, name: 'racer', email: NEW_EMAIL }))
    )

    const response = await post(passwordBody())

    expect(await read(response)).toBe('更新邮箱失败, 请稍后重试')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    expect(db.emailChanges()).toEqual([])
    expect(kv.get(NEW_EMAIL)?.value).toBe(CODE)
    // 通知已在写库前发出: 旧邮箱收到的是一封链接打不开的提醒
    expect(mail.outbox).toHaveLength(1)
  })

  it('reports a failed write when the DB throws', async () => {
    db.failNextWrite(new Error('connection reset'))

    const response = await post(passwordBody())

    expect(await read(response)).toBe('更新邮箱失败, 请稍后重试')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    expect(db.emailChanges()).toEqual([])
    expect(db.transactions).toEqual([{ committed: false }])
  })

  // 读到的旧邮箱与提交时库里的不一致 (管理员在这之间改过): 以旧邮箱为条件的更新落空
  it('does nothing when the account email changes between the read and the commit', async () => {
    db.interceptNextWrite(() =>
      db.patchUser(UID, { email: 'by-admin@example.com' })
    )

    const response = await post(passwordBody())

    expect(await read(response)).toBe('账户邮箱已发生变化, 请刷新后重试')
    expect(db.user(UID)?.email).toBe('by-admin@example.com')
    expect(db.emailChanges()).toEqual([])
    expect(kv.get(NEW_EMAIL)?.value).toBe(CODE)
  })
})

describe('POST /api/user/setting/email: 24-hour cooldown', () => {
  const THIRD_EMAIL = 'third@example.com'
  const COOLDOWN = '24 小时内只能修改一次邮箱, 请稍后再试'
  const DAY_MS = 24 * 60 * 60 * 1000

  beforeEach(() => {
    kv.put(THIRD_EMAIL, CODE, 600)
  })

  it('refuses a second change within 24 hours without mailing anyone', async () => {
    expect(await read(await post(passwordBody()))).toEqual({})
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + DAY_MS - 1000))

    const response = await post(passwordBody({ email: THIRD_EMAIL }))

    expect(await read(response)).toBe(COOLDOWN)
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
    expect(db.emailChanges()).toHaveLength(1)
    // 只有第一次变更发往最初邮箱的那一封
    expect(mail.outbox.map((sent) => sent.to)).toEqual([[OLD_EMAIL]])
    expect(kv.get(THIRD_EMAIL)?.value).toBe(CODE)
  })

  it('asks for the identity proof before saying anything about the cooldown', async () => {
    await post(passwordBody())

    const response = await post(
      passwordBody({ email: THIRD_EMAIL, currentPassword: WRONG_PASSWORD })
    )

    expect(await read(response)).toBe('当前密码输入错误')
  })

  it('counts a change that was reverted', async () => {
    db.insertEmailChange({
      user_id: UID,
      old_email: 'earlier@example.com',
      new_email: OLD_EMAIL,
      revert_token_hash: 'a'.repeat(64),
      created: new Date(FIXED_NOW.getTime() - 60_000),
      expires: new Date(FIXED_NOW.getTime() + DAY_MS),
      reverted: new Date(FIXED_NOW.getTime() - 30_000)
    })

    const response = await post(passwordBody())

    expect(await read(response)).toBe(COOLDOWN)
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    expect(mail.outbox).toEqual([])
  })

  it('allows the next change once 24 hours have passed', async () => {
    await post(passwordBody())
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + DAY_MS + 1000))

    const response = await post(passwordBody({ email: THIRD_EMAIL }))

    expect(await read(response)).toEqual({})
    expect(db.user(UID)?.email).toBe(THIRD_EMAIL)
    expect(db.emailChanges()).toHaveLength(2)
    // 第二次变更的提醒发给它当时的旧邮箱
    expect(mail.outbox.map((sent) => sent.to)).toEqual([
      [OLD_EMAIL],
      [NEW_EMAIL]
    ])
  })

  it("is per account: another user's recent change does not matter", async () => {
    db.insertEmailChange({
      user_id: 8,
      old_email: 'x@example.com',
      new_email: TAKEN_EMAIL,
      revert_token_hash: 'b'.repeat(64),
      created: FIXED_NOW,
      expires: new Date(FIXED_NOW.getTime() + DAY_MS),
      reverted: null
    })

    expect(await read(await post(passwordBody()))).toEqual({})
  })

  // 预检之后、提交之前另一个请求先完成了一次变更: 行锁下的那次判定兜住
  it('rolls the email back when a concurrent change lands between the pre-check and the commit', async () => {
    db.interceptNextWrite(() => {
      db.insertEmailChange({
        user_id: UID,
        old_email: 'earlier@example.com',
        new_email: OLD_EMAIL,
        revert_token_hash: 'c'.repeat(64),
        created: FIXED_NOW,
        expires: new Date(FIXED_NOW.getTime() + DAY_MS),
        reverted: null
      })
    })

    const response = await post(passwordBody())

    expect(await read(response)).toBe(COOLDOWN)
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    expect(db.emailChanges()).toHaveLength(1)
    expect(db.transactions).toEqual([{ committed: false }])
    expect(kv.get(NEW_EMAIL)?.value).toBe(CODE)
  })
})
