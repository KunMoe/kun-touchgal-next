import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { generateConfig, Hotp } from 'time2fa'
import {
  contractSubjectId,
  openRedisContract,
  redisContractUrl
} from '~/lib/__tests__/redisContract'
import type { RedisContract } from '~/lib/__tests__/redisContract'

// 已用时间步登记与 step-up 预算在真 Redis 上的语义 (运行方式见 lib/__tests__/redisContract.ts)。
// 只有库是假的: 每个用例的用户都启用了 2FA, 密钥是 SECRET

const SECRET = 'JBSWY3DPEHPK3PXP'

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findUnique: async () => ({ enable_2fa: true, two_factor_secret: SECRET })
    }
  }
}))

const stepNow = () => Math.floor(Date.now() / 30_000)
const codeAt = (step: number) =>
  Hotp.generatePasscode({ secret: SECRET, counter: step }, generateConfig())

describe.skipIf(!redisContractUrl)('second factor on real Redis', () => {
  let kv: RedisContract
  let secondFactor: typeof import('~/server/auth/secondFactor')
  let createdKeys: string[] = []

  beforeAll(async () => {
    kv = await openRedisContract()
    secondFactor = await import('~/server/auth/secondFactor')
  })

  afterEach(async () => {
    if (createdKeys.length) {
      await kv.del(...createdKeys)
    }
    createdKeys = []
  })

  afterAll(() => {
    kv?.close()
  })

  const usedKey = (uid: number, step: number) => `auth:totp:used:${uid}:${step}`
  const budgetKey = (uid: number) => `auth:stepup:2fa:uid:${uid}`

  const newUid = () => {
    const uid = contractSubjectId()
    const step = stepNow()
    createdKeys.push(
      budgetKey(uid),
      ...[-2, -1, 0, 1, 2].map((offset) => usedKey(uid, step + offset))
    )
    return uid
  }

  it('accepts a code once and remembers its time step for two minutes', async () => {
    const uid = newUid()
    const step = stepNow()
    const code = codeAt(step)

    await expect(secondFactor.checkTotp(uid, SECRET, code)).resolves.toBe('ok')
    await expect(secondFactor.checkTotp(uid, SECRET, code)).resolves.toBe(
      'replayed'
    )

    const ttl = await kv.ttl(usedKey(uid, step))
    expect(ttl).toBeLessThanOrEqual(120)
    expect(ttl).toBeGreaterThan(115)
  })

  it('records each time step separately and per user', async () => {
    const uid = newUid()
    const other = newUid()
    const step = stepNow()

    await expect(
      secondFactor.checkTotp(uid, SECRET, codeAt(step - 1))
    ).resolves.toBe('ok')
    // 前一步用过, 不影响当前步的码, 也不影响另一个用户
    await expect(
      secondFactor.checkTotp(uid, SECRET, codeAt(step))
    ).resolves.toBe('ok')
    await expect(
      secondFactor.checkTotp(other, SECRET, codeAt(step - 1))
    ).resolves.toBe('ok')
    await expect(
      secondFactor.checkTotp(uid, SECRET, codeAt(step - 1))
    ).resolves.toBe('replayed')
  })

  it('lets exactly one of several concurrent requests use the same code', async () => {
    const uid = newUid()
    const code = codeAt(stepNow())

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        secondFactor.checkTotp(uid, SECRET, code)
      )
    )

    expect(results.filter((result) => result === 'ok')).toHaveLength(1)
    expect(results.filter((result) => result === 'replayed')).toHaveLength(11)
  })

  // 判别用例: 同一个码不能先用来登录 (checkTotp), 再拿去过设置页的二次验证, 反过来也不行
  it('rejects a code replayed across the login and the settings entry', async () => {
    const uid = newUid()
    const step = stepNow()

    await expect(
      secondFactor.checkTotp(uid, SECRET, codeAt(step))
    ).resolves.toBe('ok')
    await expect(
      secondFactor.verifySecondFactor(
        uid,
        { kind: 'totp', code: codeAt(step) },
        { ip: '' }
      )
    ).resolves.toEqual({ ok: false, reason: 'replayed' })

    await expect(
      secondFactor.verifySecondFactor(
        uid,
        { kind: 'totp', code: codeAt(step - 1) },
        { ip: '' }
      )
    ).resolves.toEqual({ ok: true })
    await expect(
      secondFactor.checkTotp(uid, SECRET, codeAt(step - 1))
    ).resolves.toBe('replayed')
  })

  it('locks the settings entry after ten wrong codes, even for a correct one', async () => {
    const uid = newUid()
    const wrong = { kind: 'totp', code: '000000' } as const

    for (let attempt = 0; attempt < 10; attempt++) {
      await expect(
        secondFactor.verifySecondFactor(uid, wrong, { ip: '' })
      ).resolves.toEqual({ ok: false, reason: 'invalid' })
    }

    await expect(
      secondFactor.verifySecondFactor(
        uid,
        { kind: 'totp', code: codeAt(stepNow()) },
        { ip: '' }
      )
    ).resolves.toEqual({ ok: false, reason: 'locked' })
    expect(await kv.get(budgetKey(uid))).toBe('10')
  })

  it('forgives earlier wrong codes once a correct one arrives', async () => {
    const uid = newUid()

    for (let attempt = 0; attempt < 3; attempt++) {
      await secondFactor.verifySecondFactor(
        uid,
        { kind: 'totp', code: '000000' },
        { ip: '' }
      )
    }
    expect(await kv.get(budgetKey(uid))).toBe('3')

    await expect(
      secondFactor.verifySecondFactor(
        uid,
        { kind: 'totp', code: codeAt(stepNow()) },
        { ip: '' }
      )
    ).resolves.toEqual({ ok: true })
    expect(await kv.get(budgetKey(uid))).toBeNull()
  })

  it('charges a replayed code against the budget', async () => {
    const uid = newUid()
    const proof = { kind: 'totp', code: codeAt(stepNow()) } as const

    await secondFactor.verifySecondFactor(uid, proof, { ip: '' })
    await expect(
      secondFactor.verifySecondFactor(uid, proof, { ip: '' })
    ).resolves.toEqual({ ok: false, reason: 'replayed' })

    expect(await kv.get(budgetKey(uid))).toBe('1')
  })
})
