import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { KUN_ROLE } from '~/constants/role'

// 生成 2FA 密钥入口的可观察行为。边界用内存态假件, 密码哈希与 TOTP 走真实实现
const fakes = await vi.hoisted(async () =>
  (
    await import('~/app/api/user/setting/__tests__/_credentialFakes')
  ).createCredentialFakes()
)

vi.mock('~/prisma/index', () => fakes.modules.prisma)
vi.mock('~/lib/redis', () => fakes.modules.redis)
vi.mock('~/server/auth/attemptBudget', () => fakes.modules.budget)
vi.mock('~/middleware/_verifyHeaderCookie', () => fakes.modules.session)
vi.mock('~/server/auth/session', () => fakes.modules.sessionStore)

import { hashPassword } from '~/server/auth/algorithm'
import {
  FIXED_NOW,
  jsonRequest,
  makeUser,
  TOTP_SECRET,
  totpAt
} from '~/app/api/user/setting/__tests__/_credentialFakes'
import { POST as enable } from '~/app/api/user/setting/2fa/enable/route'
import { POST } from '~/app/api/user/setting/2fa/save-secret/route'

const { db, session } = fakes
const UID = 7
const PASSWORD = 'oldpass123'
// 慢机器上 argon2 (纯 JS) 单次可达数百毫秒, 多次校验的用例放宽时限
const ARGON2_HEAVY_TIMEOUT = 60_000

let passwordHash = ''

const post = (body: unknown = { currentPassword: PASSWORD }) =>
  POST(
    jsonRequest('/api/user/setting/2fa/save-secret', body, {
      'x-real-ip': '203.0.113.8'
    }) as unknown as Parameters<typeof POST>[0]
  )

const read = async (response: Response) => response.json()

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
  db.insertUser(
    makeUser({
      id: UID,
      name: 'kun',
      password: passwordHash,
      two_factor_backup: ['h1:stale']
    })
  )
  session.signIn(UID, KUN_ROLE.USER)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('POST /api/user/setting/2fa/save-secret', () => {
  it('rejects an anonymous request without reading the DB', async () => {
    session.signOut()

    expect(await read(await post())).toBe('用户未登录')
    expect(db.queries).toEqual([])
  })

  // 只凭会话就能生成密钥的话, 被窃的会话可以给账号挂上别人的身份验证器
  it.each([
    ['no body at all', undefined],
    ['an empty body', {}],
    ['an empty password', { currentPassword: '' }]
  ])(
    'asks for the current password given %s, and stores nothing',
    async (_, body) => {
      const response = await POST(
        new Request('http://localhost/api/user/setting/2fa/save-secret', {
          method: 'POST',
          ...(body ? { body: JSON.stringify(body) } : {})
        }) as unknown as Parameters<typeof POST>[0]
      )

      expect(await read(response)).toBe('请输入当前密码')
      expect(db.queries).toEqual([])
      expect(db.user(UID)?.two_factor_secret).toBe('')
    }
  )

  it('rejects a wrong current password and stores nothing', async () => {
    const response = await post({ currentPassword: 'wrongpass789' })

    expect(await read(response)).toBe('当前密码输入错误')
    expect(db.user(UID)).toMatchObject({
      two_factor_secret: '',
      two_factor_backup: ['h1:stale']
    })
  })

  it(
    'locks after ten wrong passwords, even for the right one',
    async () => {
      for (let i = 0; i < 10; i++) {
        await POST(
          jsonRequest(
            '/api/user/setting/2fa/save-secret',
            { currentPassword: `wrongpass${i}` },
            { 'x-real-ip': `203.0.113.${i}` }
          ) as unknown as Parameters<typeof POST>[0]
        )
      }

      const response = await POST(
        jsonRequest(
          '/api/user/setting/2fa/save-secret',
          { currentPassword: PASSWORD },
          { 'x-real-ip': '203.0.113.99' }
        ) as unknown as Parameters<typeof POST>[0]
      )

      expect(await read(response)).toBe('密码尝试次数过多, 请 15 分钟后再试')
      expect(db.user(UID)?.two_factor_secret).toBe('')
    },
    ARGON2_HEAVY_TIMEOUT
  )

  it('answers 用户不存在 when the session user has no row', async () => {
    db.reset()

    expect(await read(await post())).toBe('用户不存在')
  })

  it('refuses to replace the secret of an enabled account', async () => {
    db.patchUser(UID, {
      enable_2fa: true,
      two_factor_secret: TOTP_SECRET,
      two_factor_backup: ['h1:kept']
    })

    const response = await post()

    expect(await read(response)).toBe('请先关闭现有 2FA 后再重新设置')
    expect(db.user(UID)).toMatchObject({
      enable_2fa: true,
      two_factor_secret: TOTP_SECRET,
      two_factor_backup: ['h1:kept']
    })
  })

  it('stores a pending secret for the right password and clears backup codes', async () => {
    const body = await read(await post())

    expect(Object.keys(body).sort()).toEqual(['authUrl', 'qrCodeUrl', 'secret'])
    expect(body.secret).toMatch(/^[A-Z2-7]{16}$/)
    expect(body.authUrl).toMatch(/^otpauth:\/\/totp\/TouchGal:kun\?/)
    expect(new URL(body.authUrl).searchParams.get('secret')).toBe(body.secret)
    expect(body.qrCodeUrl).toMatch(/^data:image\/png;base64,/)
    expect(db.user(UID)).toMatchObject({
      enable_2fa: false,
      two_factor_secret: body.secret,
      two_factor_backup: []
    })
  })

  it('replaces the pending secret when called again', async () => {
    const first = await read(await post())
    const second = await read(await post())

    expect(second.secret).not.toBe(first.secret)
    expect(db.user(UID)?.two_factor_secret).toBe(second.secret)
  })

  it('answers a state-changed message when 2FA turns on between the read and the write', async () => {
    // 另一个请求在读取与条件写之间完成了开启
    db.interceptNextWrite(() =>
      db.patchUser(UID, { enable_2fa: true, two_factor_secret: TOTP_SECRET })
    )

    const response = await post()

    expect(await read(response)).toBe('当前 2FA 状态已变化，请刷新后重试')
    expect(db.user(UID)).toMatchObject({
      enable_2fa: true,
      two_factor_secret: TOTP_SECRET
    })
  })

  it('hands out a secret that the enable route then accepts', async () => {
    const { secret } = await read(await post())

    const response = await enable(
      jsonRequest('/api/user/setting/2fa/enable', {
        token: totpAt(secret)
      }) as unknown as Parameters<typeof enable>[0]
    )

    expect((await read(response)).backupCode).toHaveLength(10)
    expect(db.user(UID)).toMatchObject({
      enable_2fa: true,
      two_factor_secret: secret
    })
  })
})
