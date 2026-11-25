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
import { KUN_BODY_BUDGET } from '~/constants/bodyBudget'

// 撤销邮箱变更入口的可观察行为。令牌先查台账 (user_email_change); 台账上线之前发出的链接
// 状态还在 Redis 里, 回落到旧路径, 那一段按上线前的行为原样钉住
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
  makeUser
} from '~/app/api/user/setting/__tests__/_credentialFakes'
import { POST as changeEmail } from '~/app/api/user/setting/email/route'
import { GET, POST } from '~/app/api/user/setting/email/revert/route'

const { db, kv, mail, session } = fakes
const UID = 7
const OLD_EMAIL = 'old@example.com'
const NEW_EMAIL = 'new@example.com'
const TOKEN = 'revert-token-1'
const REVERT_PREFIX = 'email-change-revert:'

const revertPath = '/api/user/setting/email/revert'

const DAY_MS = 24 * 60 * 60 * 1000

// 台账里的一次变更: OLD_EMAIL → NEW_EMAIL, 令牌是 token
const recordChange = (
  token: string,
  overrides: Partial<{
    old_email: string
    created: Date
    expires: Date
    reverted: Date | null
  }> = {}
) =>
  db.insertEmailChange({
    user_id: UID,
    old_email: OLD_EMAIL,
    new_email: NEW_EMAIL,
    revert_token_hash: createHash('sha256').update(token).digest('hex'),
    created: FIXED_NOW,
    expires: new Date(FIXED_NOW.getTime() + DAY_MS),
    reverted: null,
    ...overrides
  })

// 台账上线之前的撤销记录
const putRevert = (
  token: string,
  payload: Record<string, unknown> = {
    uid: UID,
    oldEmail: OLD_EMAIL,
    newEmail: NEW_EMAIL,
    createdAt: FIXED_NOW.toISOString()
  }
) => kv.put(`${REVERT_PREFIX}${token}`, JSON.stringify(payload), 86400)

const getPage = (query: string) =>
  GET(
    new Request(
      `http://localhost${revertPath}${query}`
    ) as unknown as Parameters<typeof GET>[0]
  )

const postForm = (fields: Record<string, string>) =>
  POST(
    new Request(`http://localhost${revertPath}`, {
      method: 'POST',
      body: new URLSearchParams(fields)
    }) as unknown as Parameters<typeof POST>[0]
  )

const postJson = (body: unknown) =>
  POST(jsonRequest(revertPath, body) as unknown as Parameters<typeof POST>[0])

const titleOf = async (response: Response) => {
  const html = await response.text()
  return html.match(/<title>(.*?)<\/title>/)?.[1]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  fakes.reset()
  db.insertUser(makeUser({ id: UID, email: NEW_EMAIL }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/user/setting/email/revert', () => {
  it.each(['', '?token=', '?token=%20%20'])(
    'answers 400 撤销链接无效 for a missing token (%j)',
    async (query) => {
      const response = await getPage(query)

      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8'
      )
      expect(await titleOf(response)).toBe('撤销链接无效')
    }
  )

  it('renders a confirm page for a recorded change without changing anything', async () => {
    recordChange(TOKEN)

    const response = await getPage(`?token=${TOKEN}`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<title>确认撤销邮箱变更</title>')
    expect(html).toContain(`账户邮箱将恢复为 ${OLD_EMAIL}`)
    expect(html).toContain(
      `<input type="hidden" name="token" value="${TOKEN}" />`
    )
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
    expect(db.emailChanges()[0].reverted).toBeNull()
  })

  it.each([
    ['already reverted', { reverted: FIXED_NOW }],
    ['past its 24 hours', { expires: FIXED_NOW }]
  ])(
    'answers 400 撤销链接已失效 for a change %s',
    async (_label, overrides) => {
      recordChange(TOKEN, overrides)

      const response = await getPage(`?token=${TOKEN}`)

      expect(response.status).toBe(400)
      expect(await titleOf(response)).toBe('撤销链接已失效')
    }
  )

  it('HTML-escapes the old address of a recorded change', async () => {
    recordChange(TOKEN, { old_email: `o"<x>&'@example.com` })

    const html = await (await getPage(`?token=${TOKEN}`)).text()

    expect(html).toContain('恢复为 o&quot;&lt;x&gt;&amp;&#39;@example.com')
    expect(html).not.toContain(`o"<x>`)
  })
})

describe('POST /api/user/setting/email/revert', () => {
  it.each([
    ['form', () => postForm({ token: TOKEN })],
    ['JSON', () => postJson({ token: TOKEN })]
  ])(
    'restores the old address from a %s body without any session, then signs every session out',
    async (_label, send) => {
      recordChange(TOKEN)
      let emailAtRevoke = ''
      session.onRevoke((uid) => {
        emailAtRevoke = db.user(uid)?.email ?? ''
      })

      const response = await send()
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('<title>邮箱已恢复</title>')
      expect(html).toContain(`账户邮箱已恢复为 ${OLD_EMAIL}`)
      expect(html).toContain('全部登录会话已被登出')
      expect(db.user(UID)?.email).toBe(OLD_EMAIL)
      expect(db.emailChanges()[0].reverted).toEqual(FIXED_NOW)
      expect(db.transactions).toEqual([{ committed: true }])
      // 改走邮箱的人手里多半还握着一个会话; 登出发生在邮箱改回之后
      expect(session.revokedUids).toEqual([UID])
      // 策略表 email-reverted: 与改回邮箱同一条语句刷新安全戳, 已签发给依赖方的 OIDC 令牌一并作废
      expect(db.user(UID)?.security_stamp).toBeInstanceOf(Date)
      expect(emailAtRevoke).toBe(OLD_EMAIL)
    }
  )

  it('works only once', async () => {
    recordChange(TOKEN)

    const first = await postForm({ token: TOKEN })
    const replay = await postForm({ token: TOKEN })

    expect(first.status).toBe(200)
    expect(replay.status).toBe(400)
    expect(await titleOf(replay)).toBe('撤销链接已失效')
    expect(session.revokedUids).toEqual([UID])
  })

  it('answers 400 撤销链接已失效 past the 24 hours and changes nothing', async () => {
    recordChange(TOKEN)
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + DAY_MS))

    const response = await postForm({ token: TOKEN })

    expect(response.status).toBe(400)
    expect(await titleOf(response)).toBe('撤销链接已失效')
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
    expect(session.revokedUids).toEqual([])
  })

  // 冷却期内用户自己改不了第二次, 邮箱对不上只可能是管理员在后台改过
  it('answers 400 无需撤销 when an admin changed the email since, and keeps the token', async () => {
    recordChange(TOKEN)
    db.patchUser(UID, { email: 'by-admin@example.com' })

    const response = await postForm({ token: TOKEN })
    const html = await response.text()

    expect(response.status).toBe(400)
    expect(html).toContain('<title>无需撤销</title>')
    expect(html).toContain('可能已由管理员修改')
    expect(db.user(UID)?.email).toBe('by-admin@example.com')
    expect(db.emailChanges()[0].reverted).toBeNull()
    expect(db.transactions).toEqual([{ committed: false }])
    expect(session.revokedUids).toEqual([])
  })

  it('answers 500 撤销失败 and keeps the token when the old address was taken meanwhile', async () => {
    recordChange(TOKEN)
    db.insertUser(makeUser({ id: 8, name: 'other', email: OLD_EMAIL }))

    const response = await postForm({ token: TOKEN })
    const html = await response.text()

    expect(response.status).toBe(500)
    expect(html).toContain('<title>撤销失败</title>')
    // 重试没有用, 直说要找管理员
    expect(html).toContain('已被其他账户使用')
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
    expect(db.emailChanges()[0].reverted).toBeNull()
    expect(session.revokedUids).toEqual([])
  })

  it('asks to try again, without using the token up, when the database fails', async () => {
    recordChange(TOKEN)
    db.failNextWrite(new Error('connection reset'))

    const failed = await postForm({ token: TOKEN })
    const html = await failed.text()

    expect(failed.status).toBe(500)
    expect(html).toContain('请稍后重新打开邮件里的撤销链接')
    expect(html).not.toContain('已被其他账户使用')
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)

    const retried = await postForm({ token: TOKEN })
    expect(retried.status).toBe(200)
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
  })

  it('still reports the restored address when signing the sessions out fails', async () => {
    recordChange(TOKEN)
    session.onRevoke(() => {
      throw new Error('redis unavailable')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await postForm({ token: TOKEN })
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain(`账户邮箱已恢复为 ${OLD_EMAIL}`)
    expect(html).toContain('请立即修改密码')
    expect(html).not.toContain('全部登录会话已被登出')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
  })

  it.each([
    ['an empty form', () => postForm({})],
    ['a blank form token', () => postForm({ token: '   ' })],
    ['JSON without token', () => postJson({})],
    ['JSON with a non-string token', () => postJson({ token: 1 })]
  ])('answers 400 撤销链接无效 for %s', async (_label, send) => {
    const response = await send()

    expect(response.status).toBe(400)
    expect(await titleOf(response)).toBe('撤销链接无效')
    expect(db.queries).toEqual([])
  })

  it('treats a body over the 16 KiB budget as carrying no token, and keeps the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    recordChange(TOKEN)

    const response = await postForm({
      token: TOKEN,
      pad: 'a'.repeat(KUN_BODY_BUDGET.tiny)
    })

    expect(response.status).toBe(400)
    expect(await titleOf(response)).toBe('撤销链接无效')
    expect(db.queries).toEqual([])
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
    expect(warn).toHaveBeenCalledWith(
      '[kunReadBody] rejected',
      expect.objectContaining({ path: revertPath, reason: 'too-large' })
    )
  })

  it('answers 400 撤销链接已失效 for a token nobody issued', async () => {
    const response = await postForm({ token: 'nope' })

    expect(response.status).toBe(400)
    expect(await titleOf(response)).toBe('撤销链接已失效')
  })
})

describe('GET /api/user/setting/email/revert: link issued before the ledger', () => {
  it.each([
    ['unknown', undefined],
    ['not JSON', 'not-json'],
    ['missing fields', JSON.stringify({ uid: UID, oldEmail: OLD_EMAIL })]
  ])('answers 400 撤销链接已失效 for a %s record', async (_label, stored) => {
    if (stored !== undefined) {
      kv.put(`${REVERT_PREFIX}${TOKEN}`, stored)
    }

    const response = await getPage(`?token=${TOKEN}`)

    expect(response.status).toBe(400)
    expect(await titleOf(response)).toBe('撤销链接已失效')
  })

  it('renders a confirm page without changing anything', async () => {
    putRevert(TOKEN)

    const response = await getPage(`?token=${TOKEN}`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<title>确认撤销邮箱变更</title>')
    expect(html).toContain(`账户邮箱将恢复为 ${OLD_EMAIL}`)
    expect(html).toContain(
      `<input type="hidden" name="token" value="${TOKEN}" />`
    )
    expect(html).toContain('action="/api/user/setting/email/revert"')
    expect(kv.get(`${REVERT_PREFIX}${TOKEN}`)).not.toBeNull()
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
  })

  it('HTML-escapes the token and the old address', async () => {
    const token = `a"<>&'b`
    const oldEmail = `o"<x>&'@example.com`
    putRevert(token, {
      uid: UID,
      oldEmail,
      newEmail: NEW_EMAIL,
      createdAt: FIXED_NOW.toISOString()
    })

    const response = await getPage(`?token=${encodeURIComponent(token)}`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('value="a&quot;&lt;&gt;&amp;&#39;b"')
    expect(html).toContain('恢复为 o&quot;&lt;x&gt;&amp;&#39;@example.com')
    expect(html).not.toContain(token)
    expect(html).not.toContain(oldEmail)
  })
})

describe('POST /api/user/setting/email/revert: link issued before the ledger', () => {
  it.each([
    ['form', () => postForm({ token: TOKEN })],
    ['JSON', () => postJson({ token: TOKEN })]
  ])(
    'restores the old address from a %s body without any session, and signs every session out too',
    async (_label, send) => {
      putRevert(TOKEN)

      const response = await send()
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('<title>邮箱已恢复</title>')
      expect(html).toContain(`账户邮箱已恢复为 ${OLD_EMAIL}`)
      expect(db.user(UID)?.email).toBe(OLD_EMAIL)
      expect(kv.get(`${REVERT_PREFIX}${TOKEN}`)).toBeNull()
      expect(session.revokedUids).toEqual([UID])
    }
  )

  it('answers 400 撤销链接已失效 for an unknown token and a replayed one', async () => {
    putRevert(TOKEN)

    const unknown = await postForm({ token: 'nope' })
    const first = await postForm({ token: TOKEN })
    const replay = await postForm({ token: TOKEN })

    expect(unknown.status).toBe(400)
    expect(await titleOf(unknown)).toBe('撤销链接已失效')
    expect(first.status).toBe(200)
    expect(replay.status).toBe(400)
    expect(await titleOf(replay)).toBe('撤销链接已失效')
  })

  // 跨上线边界的两跳: 第一跳在台账上线之前 (状态只在 Redis, 冷却看不到), 第二跳在之后。
  // 发往最初邮箱的旧链接仍要把邮箱恢复回去
  it('follows a later recorded change back to the original address', async () => {
    const LATER_EMAIL = 'later@example.com'
    const LATER_TOKEN = 'later-token'
    putRevert(TOKEN)
    db.patchUser(UID, { email: LATER_EMAIL })
    db.insertEmailChange({
      user_id: UID,
      old_email: NEW_EMAIL,
      new_email: LATER_EMAIL,
      revert_token_hash: createHash('sha256').update(LATER_TOKEN).digest('hex'),
      created: FIXED_NOW,
      expires: new Date(FIXED_NOW.getTime() + DAY_MS),
      reverted: null
    })

    const response = await postForm({ token: TOKEN })

    expect(response.status).toBe(200)
    expect(await titleOf(response)).toBe('邮箱已恢复')
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
    expect(db.emailChanges()[0].reverted).toEqual(FIXED_NOW)
    expect(kv.get(`${REVERT_PREFIX}${TOKEN}`)).toBeNull()
    expect(session.revokedUids).toEqual([UID])
    expect(db.transactions).toEqual([{ committed: true }])

    // 后一跳自己的撤销链接 (在改走邮箱的人手里) 随之作废
    const later = await postForm({ token: LATER_TOKEN })
    expect(later.status).toBe(400)
    expect(db.user(UID)?.email).toBe(OLD_EMAIL)
  })

  it('answers 400 无需撤销 and burns the token when the account moved on', async () => {
    putRevert(TOKEN)
    db.patchUser(UID, { email: 'elsewhere@example.com' })

    const response = await postForm({ token: TOKEN })

    expect(response.status).toBe(400)
    expect(await titleOf(response)).toBe('无需撤销')
    expect(db.user(UID)?.email).toBe('elsewhere@example.com')
    expect(kv.get(`${REVERT_PREFIX}${TOKEN}`)).toBeNull()
  })

  it('answers 500 撤销失败 and keeps the token when the write fails', async () => {
    putRevert(TOKEN)
    // 旧地址已被别的账户占用, 写入撞唯一约束
    db.insertUser(makeUser({ id: 8, name: 'other', email: OLD_EMAIL }))

    const response = await postForm({ token: TOKEN })

    expect(response.status).toBe(500)
    expect(await titleOf(response)).toBe('撤销失败')
    expect(db.user(UID)?.email).toBe(NEW_EMAIL)
    expect(kv.get(`${REVERT_PREFIX}${TOKEN}`)).not.toBeNull()
  })
})

describe('email change followed by revert (end to end)', () => {
  const PASSWORD = 'kunpass123'
  const CODE = 'AbC1234'
  let passwordHash = ''

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD)
  })

  const change = async (email: string) => {
    kv.put(email, CODE, 600)
    const response = await changeEmail(
      jsonRequest(
        '/api/user/setting/email',
        { email, code: CODE, currentPassword: PASSWORD },
        { 'x-real-ip': '203.0.113.8' }
      ) as unknown as Parameters<typeof changeEmail>[0]
    )
    return response.json()
  }

  const tokenMailedTo = (address: string) => {
    const notice = mail.outbox.find((sent) => sent.to.includes(address))
    return notice?.plain.match(/revert\?token=([^\s]+)/)?.[1] ?? ''
  }

  // 复核给出的场景: 第一跳发生在台账上线之前, 只在 Redis 里留下一条记录
  it('still recovers the account when the first hop predates the ledger', async () => {
    db.reset()
    db.insertUser(
      makeUser({ id: UID, email: 'b@example.com', password: passwordHash })
    )
    session.signIn(UID, KUN_ROLE.USER)
    mail.install()
    putRevert('legacy-t1', {
      uid: UID,
      oldEmail: 'a@example.com',
      newEmail: 'b@example.com',
      createdAt: FIXED_NOW.toISOString()
    })

    // 冷却看不到 Redis 里的上一跳, 第二跳拦不住
    expect(await change('c@example.com')).toEqual({})
    expect(db.user(UID)?.email).toBe('c@example.com')

    session.signOut()
    const response = await postForm({ token: 'legacy-t1' })

    expect(response.status).toBe(200)
    expect(db.user(UID)?.email).toBe('a@example.com')
    expect(session.revokedUids).toEqual([UID])

    // 撤回之后冷却仍在
    session.signIn(UID, KUN_ROLE.USER)
    expect(await change('d@example.com')).toBe(
      '24 小时内只能修改一次邮箱, 请稍后再试'
    )
  })

  // P07-01 / X07-01: 入侵者把邮箱从 A 改到 B 再改到 C, 发往 A 的撤销链接曾就此命中 0 行而作废,
  // 账号从「可自助夺回」变成「只能找管理员」
  it('keeps the first revert link working: the second hop is refused', async () => {
    db.reset()
    db.insertUser(
      makeUser({ id: UID, email: 'a@example.com', password: passwordHash })
    )
    session.signIn(UID, KUN_ROLE.USER)
    mail.install()

    expect(await change('b@example.com')).toEqual({})
    expect(await change('c@example.com')).toBe(
      '24 小时内只能修改一次邮箱, 请稍后再试'
    )
    expect(db.user(UID)?.email).toBe('b@example.com')
    // 第二跳没有发出任何提醒; 唯一的撤销链接在最初的邮箱 A 手里
    expect(mail.outbox.map((sent) => sent.to)).toEqual([['a@example.com']])
    const t1 = tokenMailedTo('a@example.com')
    expect(t1).not.toBe('')

    session.signOut()
    const response = await postForm({ token: t1 })

    expect(response.status).toBe(200)
    expect(await titleOf(response)).toBe('邮箱已恢复')
    expect(db.user(UID)?.email).toBe('a@example.com')
    expect(session.revokedUids).toEqual([UID])

    // 撤销之后冷却仍在: 入侵者即便重新登录, 24 小时内也改不走邮箱
    session.signIn(UID, KUN_ROLE.USER)
    expect(await change('c@example.com')).toBe(
      '24 小时内只能修改一次邮箱, 请稍后再试'
    )
    expect(db.user(UID)?.email).toBe('a@example.com')
  })
})
