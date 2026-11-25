import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, updateManyMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  updateManyMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findMany: findManyMock, updateMany: updateManyMock } }
}))
vi.mock('~/lib/redis', () => ({}))
vi.mock('~/server/auth/attemptBudget', () => ({}))

import { sealLegacyTotpSecrets } from '~/server/auth/twoFactorState'
import { createSecretBox } from '~/lib/crypto/secretBox'

const totpBox = createSecretBox('KUN_TWO_FACTOR_SECRET_ENC_KEY')

type Row = { id: number; two_factor_secret: string }

// 按 findMany 的 where.id.gt 与 take 从 rows 里分页, 模拟按 id 升序的游标扫描
const serve = (rows: Row[]) =>
  findManyMock.mockImplementation(
    async (args: { where: { id: { gt: number } }; take: number }) =>
      rows.filter((row) => row.id > args.where.id.gt).slice(0, args.take)
  )

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv(
    'KUN_TWO_FACTOR_SECRET_ENC_KEY',
    'test-only-two-factor-secret-kek-1234567890'
  )
  updateManyMock.mockResolvedValue({ count: 1 })
})

describe('sealLegacyTotpSecrets', () => {
  it('only counts plaintext seeds in a dry run, without writing', async () => {
    serve([
      { id: 1, two_factor_secret: 'JBSWY3DPEHPK3PXP' },
      { id: 2, two_factor_secret: totpBox.seal('KRSXG5CTMVRXEZLU') },
      { id: 3, two_factor_secret: 'GEZDGNBVGY3TQOJQ' }
    ])

    await expect(sealLegacyTotpSecrets({ apply: false })).resolves.toEqual({
      pending: 2,
      sealed: 0,
      changed: 0
    })
    expect(updateManyMock).not.toHaveBeenCalled()
    // 只扫有种子的行, 只取 id 与种子
    expect(findManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: { gt: 0 }, two_factor_secret: { not: '' } },
      select: { id: true, two_factor_secret: true },
      orderBy: { id: 'asc' }
    })
  })

  it('seals each plaintext seed on the condition that it is still the value read', async () => {
    serve([
      { id: 1, two_factor_secret: 'JBSWY3DPEHPK3PXP' },
      { id: 2, two_factor_secret: totpBox.seal('KRSXG5CTMVRXEZLU') }
    ])

    await expect(sealLegacyTotpSecrets({ apply: true })).resolves.toEqual({
      pending: 1,
      sealed: 1,
      changed: 0
    })
    expect(updateManyMock).toHaveBeenCalledTimes(1)
    const [{ where, data }] = updateManyMock.mock.calls[0]
    expect(where).toEqual({ two_factor_secret: 'JBSWY3DPEHPK3PXP', id: 1 })
    // 种子没变: 不刷新安全戳, 写入体只有这一列
    expect(Object.keys(data)).toEqual(['two_factor_secret'])
    expect(totpBox.isSealed(data.two_factor_secret)).toBe(true)
    expect(totpBox.open(data.two_factor_secret)).toBe('JBSWY3DPEHPK3PXP')
  })

  it('counts a row rebound or disabled after the scan instead of overwriting it', async () => {
    serve([{ id: 1, two_factor_secret: 'JBSWY3DPEHPK3PXP' }])
    updateManyMock.mockResolvedValue({ count: 0 })

    await expect(sealLegacyTotpSecrets({ apply: true })).resolves.toEqual({
      pending: 1,
      sealed: 0,
      changed: 1
    })
  })

  it('walks every batch by id', async () => {
    serve(
      Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        two_factor_secret: 'JBSWY3DPEHPK3PXP'
      }))
    )

    await expect(
      sealLegacyTotpSecrets({ apply: false, batchSize: 2 })
    ).resolves.toMatchObject({ pending: 5 })
    expect(findManyMock.mock.calls.map(([args]) => args.where.id.gt)).toEqual([
      0, 2, 4, 5
    ])
  })
})
