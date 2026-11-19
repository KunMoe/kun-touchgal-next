import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, KoaContextWithOIDC, RefreshToken } from 'oidc-provider'

// Characterization of the OIDC findAccount mapping in lib/oidc/account.ts
const { findUniqueMock } = vi.hoisted(() => ({ findUniqueMock: vi.fn() }))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock } }
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
  ...overrides
})

const claimsFor = async (account: Account | undefined, scope: string) =>
  account!.claims('userinfo', scope, {}, [])

beforeEach(() => {
  vi.resetAllMocks()
  findUniqueMock.mockResolvedValue(userRow())
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
        status: true
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

  it('[current: refresh token survives password change] ignores the token argument entirely', async () => {
    // A refresh token issued long ago (iat 0); nothing in the row or the select can tell
    // whether the password changed since, so the account resolves exactly as without a token
    const staleToken = {
      kind: 'RefreshToken',
      iat: 0
    } as unknown as RefreshToken

    const withToken = await findAccount(ctx, '7', staleToken)
    const withoutToken = await findAccount(ctx, '7')

    expect(withToken?.accountId).toBe('7')
    expect(await claimsFor(withToken, 'openid profile email')).toStrictEqual(
      await claimsFor(withoutToken, 'openid profile email')
    )
    expect(findUniqueMock.mock.calls[0]).toEqual(findUniqueMock.mock.calls[1])
  })

  it('serves claims from the row read in findAccount (no re-read)', async () => {
    const account = await findAccount(ctx, '7')
    findUniqueMock.mockResolvedValue(userRow({ name: 'renamed' }))

    expect((await claimsFor(account, 'openid profile')).name).toBe('kun')
    expect(findUniqueMock).toHaveBeenCalledTimes(1)
  })
})
