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

// 撤销邮箱变更入口的可观察行为 (仍按现状钉住的已知缺陷, 用例名带 [current: ...])
const fakes = await vi.hoisted(async () =>
  (
    await import('~/app/api/user/setting/__tests__/_credentialFakes')
  ).createCredentialFakes()
)

vi.mock('~/prisma/index', () => fakes.modules.prisma)
vi.mock('~/lib/redis', () => fakes.modules.redis)
vi.mock('~/server/auth/attemptBudget', () => fakes.modules.budget)
vi.mock('~/middleware/_verifyHeaderCookie', () => fakes.modules.session)
// 撤销今天不吊销会话; 也假掉 jwt, 好让「吊销了会话」以断言失败而不是导入失败的形式出现
vi.mock('~/app/api/utils/jwt', () => fakes.modules.jwt)

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

describe('POST /api/user/setting/email/revert', () => {
  it.each([
    ['form', () => postForm({ token: TOKEN })],
    ['JSON', () => postJson({ token: TOKEN })]
  ])(
    'restores the old address from a %s body without any session',
    async (_label, send) => {
      putRevert(TOKEN)

      const response = await send()
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('<title>邮箱已恢复</title>')
      expect(html).toContain(`账户邮箱已恢复为 ${OLD_EMAIL}`)
      expect(db.user(UID)?.email).toBe(OLD_EMAIL)
      expect(kv.get(`${REVERT_PREFIX}${TOKEN}`)).toBeNull()
      // 撤销成功也不吊销任何会话, 改邮箱的人手里的会话照样有效
      expect(session.revokedUids).toEqual([])
    }
  )

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

  it('[current: P07-01 / X07-01] a second change makes the first revert link useless', async () => {
    db.reset()
    db.insertUser(
      makeUser({ id: UID, email: 'a@example.com', password: passwordHash })
    )
    session.signIn(UID, KUN_ROLE.USER)
    mail.install()

    expect(await change('b@example.com')).toEqual({})
    expect(await change('c@example.com')).toEqual({})
    const t1 = tokenMailedTo('a@example.com')
    const t2 = tokenMailedTo('b@example.com')
    expect(t1).not.toBe('')
    expect(t2).not.toBe('')
    // 第二封提醒发给了中间地址 B, 不是最初的 A
    expect(mail.outbox.map((sent) => sent.to)).toEqual([
      ['a@example.com'],
      ['b@example.com']
    ])

    session.signOut()
    const response = await postForm({ token: t1 })

    expect(response.status).toBe(400)
    expect(await titleOf(response)).toBe('无需撤销')
    expect(db.user(UID)?.email).toBe('c@example.com')
    expect(kv.get(`${REVERT_PREFIX}${t1}`)).toBeNull()

    // A 的链接已被烧掉; 还能用的只有发给 B 的那条, 而它恢复到的是 B
    const second = await postForm({ token: t2 })
    expect(second.status).toBe(200)
    expect(db.user(UID)?.email).toBe('b@example.com')
    expect(session.revokedUids).toEqual([])
  })
})
