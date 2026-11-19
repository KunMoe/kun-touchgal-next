import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 安全事件与并发请求的交错 (复核 H1 / M2): 真实的 session.ts 与 securityEvents.ts,
// Redis 用内存假件, user 表是一个只认平铺 WHERE 的内存行

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

const { db, cookieSets, cookieDeletes, stampMode } = vi.hoisted(() => {
  type Row = {
    id: number
    name: string
    role: number
    status: number
    blocked_tag_ids: number[]
    security_stamp: Date | null
    password: string
  }
  const rows = new Map<number, Row>()
  const same = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date
      ? a.getTime() === b.getTime()
      : a === b
  return {
    db: {
      rows,
      prisma: {
        user: {
          findUnique: async ({ where }: { where: { id: number } }) => {
            const row = rows.get(where.id)
            return row ? { ...row } : null
          },
          update: async () => ({}),
          updateMany: async ({
            where,
            data
          }: {
            where: Record<string, unknown>
            data: Partial<Row>
          }) => {
            if (!Object.keys(data).length) {
              return { count: 0 }
            }
            const row = rows.get(where.id as number)
            if (
              !row ||
              !Object.entries(where).every(([key, value]) =>
                same(row[key as keyof Row], value)
              )
            ) {
              return { count: 0 }
            }
            rows.set(row.id, { ...row, ...data })
            return { count: 1 }
          }
        }
      }
    },
    cookieSets: [] as { name: string; value: string }[],
    cookieDeletes: [] as string[],
    stampMode: { enforce: true }
  }
})

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/prisma/index', () => ({ prisma: db.prisma }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    set: (name: string, value: string) => {
      cookieSets.push({ name, value })
    },
    delete: (name: string) => {
      cookieDeletes.push(name)
    }
  })
}))
vi.mock('~/server/auth/securityStamp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/auth/securityStamp')>()),
  rejectOnStampMismatch: vi.fn(() => stampMode.enforce)
}))

import {
  mintKunSessionToken,
  resolveKunSiteSession
} from '~/server/auth/session'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import {
  rejectOnStampMismatch,
  tokenStampOf
} from '~/server/auth/securityStamp'
import type { KunGalgamePayload } from '~/server/auth/session'

// applyKunCredentialChange 只用到 user.updateMany
const writer = db.prisma as unknown as Parameters<
  typeof applyKunCredentialChange
>[0]

const UID = 7
const T0 = new Date('2027-01-15T08:00:00.000Z').getTime()
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const signIn = async () => {
  const { token } = await mintKunSessionToken(UID)
  await flush()
  const session = await resolveKunSiteSession(token)
  if (session.kind !== 'authenticated') {
    throw new Error('expected an authenticated session')
  }
  return { token, payload: session.payload as KunGalgamePayload }
}

const alive = async (token: string) =>
  (await resolveKunSiteSession(token)).kind === 'authenticated'

// 受害者走邮件链接重置密码: 写新密码与新戳, 再删光会话
const resetPassword = async () => {
  await applyKunCredentialChange(writer, {
    uid: UID,
    event: 'password-reset',
    data: { password: 'new-hash' }
  })
  await finishKunSecurityEvent(UID, 'password-reset')
}

beforeEach(() => {
  vi.resetAllMocks()
  redis.reset()
  cookieSets.length = 0
  cookieDeletes.length = 0
  stampMode.enforce = true
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.stubEnv('JWT_SECRET', 'race-secret')
  vi.stubEnv('JWT_ISS', 'iss')
  vi.stubEnv('JWT_AUD', 'aud')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  db.rows.clear()
  db.rows.set(UID, {
    id: UID,
    name: 'kun',
    role: 1,
    status: 0,
    blocked_tag_ids: [],
    security_stamp: null,
    password: 'old-hash'
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe.each([
  ['强制模式', true],
  ['影子模式', false]
])(
  '被盗会话在「退出其它设备」途中撞上受害者的重置密码 (%s)',
  (_label, enforce) => {
    beforeEach(() => {
      stampMode.enforce = enforce
    })

    it('请求通过鉴权之后、写戳之前发生重置: 写戳落空, 不删别人的会话, 也不把自己重签回来', async () => {
      const stolen = await signIn()
      vi.setSystemTime(T0 + 1000)

      await resetPassword()
      const result = await applyKunCredentialChange(writer, {
        uid: UID,
        event: 'other-sessions-revoked',
        data: {},
        currentStamp: tokenStampOf(stolen.payload)
      })

      expect(result).toEqual({ count: 0, stamp: null })
      expect(await alive(stolen.token)).toBe(false)
      expect(cookieSets).toEqual([])
    })

    it('写戳之后、重签之前发生重置: 重签发现会话已被删, 不写回, 清掉 cookie', async () => {
      const stolen = await signIn()
      vi.setSystemTime(T0 + 1000)

      const applied = await applyKunCredentialChange(writer, {
        uid: UID,
        event: 'other-sessions-revoked',
        data: {},
        currentStamp: tokenStampOf(stolen.payload)
      })
      expect(applied.count).toBe(1)
      vi.setSystemTime(T0 + 2000)
      await resetPassword()
      await finishKunSecurityEvent(UID, 'other-sessions-revoked', {
        current: stolen.payload,
        stamp: applied.stamp
      })

      expect(cookieSets).toEqual([])
      expect(cookieDeletes).toContain('kun-galgame-patch-moe-token')
      expect(redis.has(`access:token:${UID}:${stolen.payload.jti}`)).toBe(false)
      expect(await alive(stolen.token)).toBe(false)
    })
  }
)

describe('重签与同一会话的并发请求 (复核 M2)', () => {
  it('读到重签之前令牌的请求不删刚重签的会话, 也不记成可疑的不一致', async () => {
    const current = await signIn()
    const other = await signIn()
    vi.setSystemTime(T0 + 1000)

    // 并发请求 R 读到 Redis 里的令牌之后, 当前会话完成一整次「退出其它设备」
    redis.afterNext('getKvs', async () => {
      const applied = await applyKunCredentialChange(writer, {
        uid: UID,
        event: 'other-sessions-revoked',
        data: {},
        currentStamp: tokenStampOf(current.payload)
      })
      await finishKunSecurityEvent(UID, 'other-sessions-revoked', {
        current: current.payload,
        stamp: applied.stamp
      })
    })
    const concurrent = await resolveKunSiteSession(current.token)

    expect(concurrent).toEqual({ kind: 'anonymous' })
    expect(rejectOnStampMismatch).toHaveBeenCalledWith(
      'site',
      expect.anything(),
      { quiet: true }
    )
    const reissued = cookieSets.at(-1)?.value ?? ''
    expect(await alive(reissued)).toBe(true)
    expect(await alive(other.token)).toBe(false)
  })
})
