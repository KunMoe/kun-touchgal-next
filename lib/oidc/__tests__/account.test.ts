import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AccessToken,
  Account,
  AuthorizationCode,
  KoaContextWithOIDC,
  RefreshToken
} from 'oidc-provider'

// Characterization of the OIDC findAccount mapping in lib/oidc/account.ts
const { findUniqueMock, stampMode } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  // 安全戳不一致时是否拒绝 (强制模式); 影子模式只记日志
  stampMode: { enforce: true }
}))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock } }
}))
vi.mock('~/server/auth/securityStamp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/auth/securityStamp')>()),
  rejectOnStampMismatch: vi.fn(() => stampMode.enforce)
}))

import { findAccount } from '~/lib/oidc/account'

const ctx = {} as KoaContextWithOIDC

const userRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  name: 'kun',
  email: 'kun@example.com',
  avatar: 'https://img.test/a.webp',
  bio: 'hello',
  status: 0,
  security_stamp: null,
  ...overrides
})

const claimsFor = async (account: Account | undefined, scope: string) =>
  account!.claims('userinfo', scope, {}, [])

beforeEach(() => {
  vi.resetAllMocks()
  findUniqueMock.mockResolvedValue(userRow())
  stampMode.enforce = true
})

describe('findAccount', () => {
  it('queries the user by numeric id with exactly this select', async () => {
    await findAccount(ctx, '7')

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 7 },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        bio: true,
        status: true,
        security_stamp: true
      }
    })
  })

  it.each(['abc', '7.5', 'NaN', 'Infinity'])(
    'returns undefined for the non-integer id %s without querying',
    async (id) => {
      await expect(findAccount(ctx, id)).resolves.toBeUndefined()
      expect(findUniqueMock).not.toHaveBeenCalled()
    }
  )

  it('[current] accepts any string Number() maps to an integer, and echoes it raw as accountId / sub', async () => {
    findUniqueMock.mockResolvedValue(userRow({ id: 10 }))

    const account = await findAccount(ctx, '1e1')

    expect(findUniqueMock.mock.calls[0][0].where).toEqual({ id: 10 })
    expect(account?.accountId).toBe('1e1')
    expect((await claimsFor(account, 'openid')).sub).toBe('1e1')

    // '' is Number 0: it reaches the DB as id 0
    findUniqueMock.mockResolvedValue(null)
    await expect(findAccount(ctx, '')).resolves.toBeUndefined()
    expect(findUniqueMock.mock.calls[1][0].where).toEqual({ id: 0 })
  })

  it('returns undefined when the user does not exist', async () => {
    findUniqueMock.mockResolvedValue(null)

    await expect(findAccount(ctx, '7')).resolves.toBeUndefined()
  })

  it('returns undefined for a banned user (status 2) only', async () => {
    findUniqueMock.mockResolvedValue(userRow({ status: 2 }))
    await expect(findAccount(ctx, '7')).resolves.toBeUndefined()

    for (const status of [0, 1, 3]) {
      findUniqueMock.mockResolvedValue(userRow({ status }))
      expect((await findAccount(ctx, '7'))?.accountId).toBe('7')
    }
  })

  it('returns only sub for the openid scope', async () => {
    const account = await findAccount(ctx, '7')

    expect(await claimsFor(account, 'openid')).toStrictEqual({ sub: '7' })
  })

  it('adds name / picture / profile for the profile scope', async () => {
    const account = await findAccount(ctx, '7')

    expect(await claimsFor(account, 'openid profile')).toStrictEqual({
      sub: '7',
      name: 'kun',
      picture: 'https://img.test/a.webp',
      profile: 'hello'
    })
  })

  it('maps an empty avatar / bio to undefined (keys present)', async () => {
    findUniqueMock.mockResolvedValue(userRow({ avatar: '', bio: '' }))
    const account = await findAccount(ctx, '7')

    expect(await claimsFor(account, 'openid profile')).toStrictEqual({
      sub: '7',
      name: 'kun',
      picture: undefined,
      profile: undefined
    })
  })

  it('adds email with email_verified: true for the email scope', async () => {
    const account = await findAccount(ctx, '7')

    expect(await claimsFor(account, 'openid email')).toStrictEqual({
      sub: '7',
      email: 'kun@example.com',
      email_verified: true
    })
    expect(await claimsFor(account, 'openid profile email')).toMatchObject({
      name: 'kun',
      email: 'kun@example.com'
    })
  })

  describe('令牌签发得比安全戳早 (改密、重置之后)', () => {
    // 戳 = 1000 秒; 令牌的 iat / iiat 以秒计
    const STAMP = new Date(1_000_000)
    const token = (kind: string, fields: Record<string, number>) =>
      ({ kind, ...fields }) as unknown as
        RefreshToken | AccessToken | AuthorizationCode

    beforeEach(() => {
      findUniqueMock.mockResolvedValue(userRow({ security_stamp: STAMP }))
    })

    it.each([
      ['RefreshToken', { iat: 2000, iiat: 999 }],
      ['AccessToken', { iat: 999 }],
      ['AuthorizationCode', { iat: 999 }]
    ])('%s: 不再给出身份', async (kind, fields) => {
      await expect(
        findAccount(ctx, '7', token(kind, fields))
      ).resolves.toBeUndefined()
    })

    it('refresh token 按最初签发时刻 (iiat) 比, 轮换出来的新 iat 不算', async () => {
      await expect(
        findAccount(ctx, '7', token('RefreshToken', { iat: 5000, iiat: 999 }))
      ).resolves.toBeUndefined()
      expect(
        (
          await findAccount(
            ctx,
            '7',
            token('RefreshToken', { iat: 5000, iiat: 1000 })
          )
        )?.accountId
      ).toBe('7')
    })

    it('与变更同一秒或之后签发的令牌照常放行', async () => {
      for (const iat of [1000, 1001]) {
        expect(
          (await findAccount(ctx, '7', token('AccessToken', { iat })))
            ?.accountId
        ).toBe('7')
      }
    })

    it('不带令牌 (授权端点载入账号) 时不比较', async () => {
      expect((await findAccount(ctx, '7'))?.accountId).toBe('7')
    })

    it('库里没有戳 (从未变更) 时任何令牌都放行', async () => {
      findUniqueMock.mockResolvedValue(userRow())

      expect(
        (await findAccount(ctx, '7', token('RefreshToken', { iat: 0 })))
          ?.accountId
      ).toBe('7')
    })

    it('影子模式: 只记日志, 照常给出身份', async () => {
      stampMode.enforce = false

      expect(
        (await findAccount(ctx, '7', token('AccessToken', { iat: 999 })))
          ?.accountId
      ).toBe('7')
    })
  })

  it('serves claims from the row read in findAccount (no re-read)', async () => {
    const account = await findAccount(ctx, '7')
    findUniqueMock.mockResolvedValue(userRow({ name: 'renamed' }))

    expect((await claimsFor(account, 'openid profile')).name).toBe('kun')
    expect(findUniqueMock).toHaveBeenCalledTimes(1)
  })
})
