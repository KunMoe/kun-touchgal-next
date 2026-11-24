import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KUN_ROLE } from '~/constants/role'

// 管理员关闭用户 2FA 入口的可观察行为。边界用内存态假件 (事务假件记录提交 / 回滚)
const fakes = await vi.hoisted(async () =>
  (
    await import('~/app/api/user/setting/__tests__/_credentialFakes')
  ).createCredentialFakes()
)

vi.mock('~/prisma/index', () => fakes.modules.prisma)
vi.mock('~/lib/redis', () => fakes.modules.redis)
vi.mock('~/middleware/_verifyHeaderCookie', () => fakes.modules.session)
vi.mock('~/server/auth/session', () => fakes.modules.sessionStore)

import {
  jsonRequest,
  makeUser,
  TOTP_SECRET
} from '~/app/api/user/setting/__tests__/_credentialFakes'
import { POST } from '~/app/api/admin/user/2fa/disable/route'

const { db, session } = fakes
const ADMIN_UID = 1
const TARGET_UID = 7

const post = (body: unknown) =>
  POST(
    jsonRequest('/api/admin/user/2fa/disable', body) as unknown as Parameters<
      typeof POST
    >[0]
  )

const read = async (response: Response) => response.json()

const enabledTarget = {
  enable_2fa: true,
  two_factor_secret: TOTP_SECRET,
  two_factor_backup: ['h1:aaa', 'h1:bbb']
}

beforeEach(() => {
  fakes.reset()
  db.insertUser(
    makeUser({
      id: ADMIN_UID,
      name: 'boss',
      email: 'boss@example.com',
      role: KUN_ROLE.SUPER_ADMIN
    })
  )
  db.insertUser(
    makeUser({
      id: TARGET_UID,
      name: 'victim',
      email: 'victim@example.com',
      ...enabledTarget
    })
  )
  session.signIn(ADMIN_UID, KUN_ROLE.SUPER_ADMIN, 'boss')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/admin/user/2fa/disable', () => {
  it.each([
    [{ uid: 'abc' }, '用户 ID 无效'],
    [{}, '用户 ID 无效'],
    // zod 4 的 schema 级 message 也盖住 min / max 的文案
    [{ uid: 0 }, '用户 ID 无效']
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

    const invalid = await post({ uid: 'abc' })
    const valid = await post({ uid: TARGET_UID })

    expect(await read(invalid)).toBe('用户 ID 无效')
    expect(await read(valid)).toBe('用户未登录')
    expect(db.queries).toEqual([])
  })

  it.each([
    ['an admin', KUN_ROLE.ADMIN],
    ['a creator', KUN_ROLE.CREATOR],
    ['a user', KUN_ROLE.USER]
  ])('turns away %s without reading the DB', async (_label, role) => {
    session.signIn(ADMIN_UID, role, 'boss')

    const response = await post({ uid: TARGET_UID })

    expect(await read(response)).toBe('本页面仅超级管理员可访问')
    expect(db.queries).toEqual([])
    expect(db.user(TARGET_UID)).toMatchObject(enabledTarget)
  })

  it('answers 未找到该用户 for a missing target', async () => {
    const response = await post({ uid: 999 })

    expect(await read(response)).toBe('未找到该用户')
    expect(session.revokedUids).toEqual([])
  })

  it('answers 该用户尚未启用两步验证 for a target without 2FA', async () => {
    db.patchUser(TARGET_UID, { enable_2fa: false })

    const response = await post({ uid: TARGET_UID })

    expect(await read(response)).toBe('该用户尚未启用两步验证')
    expect(db.adminLogs()).toEqual([])
  })

  it('answers 未找到该管理员 when the session user has no row', async () => {
    session.signIn(42, KUN_ROLE.SUPER_ADMIN, 'ghost')

    const response = await post({ uid: TARGET_UID })

    expect(await read(response)).toBe('未找到该管理员')
    expect(db.user(TARGET_UID)).toMatchObject(enabledTarget)
    expect(db.adminLogs()).toEqual([])
  })

  it('clears 2FA and writes the admin log in one committed transaction, then revokes sessions', async () => {
    let atRevoke: unknown
    session.onRevoke(() => {
      atRevoke = {
        transactions: [...db.transactions],
        enabled: db.user(TARGET_UID)?.enable_2fa,
        logs: db.adminLogs().length
      }
    })

    const response = await post({ uid: TARGET_UID })

    expect(await read(response)).toEqual({})
    expect(db.user(TARGET_UID)).toMatchObject({
      enable_2fa: false,
      two_factor_secret: '',
      two_factor_backup: []
    })
    expect(db.adminLogs()).toEqual([
      {
        id: 1,
        type: 'update',
        user_id: ADMIN_UID,
        content: `管理员 boss 关闭了用户 victim (${TARGET_UID}) 的两步验证`
      }
    ])
    expect(db.transactions).toEqual([{ committed: true }])
    expect(session.revokedUids).toEqual([TARGET_UID])
    // 吊销发生在事务提交之后
    expect(atRevoke).toEqual({
      transactions: [{ committed: true }],
      enabled: false,
      logs: 1
    })
  })

  // 关闭是条件写入: 预检之后目标自己先关掉了, 不能再记一条「管理员关闭」的日志
  it('writes no log and revokes nothing when the target turns 2FA off first', async () => {
    db.interceptNextWrite(() => {
      db.patchUser(TARGET_UID, { enable_2fa: false, two_factor_secret: '' })
    })

    const response = await post({ uid: TARGET_UID })

    expect(await read(response)).toBe('该用户尚未启用两步验证')
    expect(db.adminLogs()).toEqual([])
    expect(db.transactions).toEqual([{ committed: false }])
    expect(session.revokedUids).toEqual([])
  })

  it('rolls the 2FA write back and revokes nothing when the log insert fails', async () => {
    db.interceptNextWrite(() => {
      // 第一笔写是关闭 2FA 的条件更新, 放过; 第二笔 admin_log.create 失败
      db.failNextWrite(new Error('admin_log insert failed'))
    })

    await expect(post({ uid: TARGET_UID })).rejects.toThrow(
      'admin_log insert failed'
    )

    expect(db.user(TARGET_UID)).toMatchObject(enabledTarget)
    expect(db.adminLogs()).toEqual([])
    expect(db.transactions).toEqual([{ committed: false }])
    expect(session.revokedUids).toEqual([])
  })
})
