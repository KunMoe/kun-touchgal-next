import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeRawMock } = vi.hoisted(() => ({
  executeRawMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { $executeRaw: executeRawMock }
}))

import {
  consumeTwoFactorBackupCode,
  hashTwoFactorBackupCode,
  isHashedTwoFactorBackupCode
} from '~/server/auth/twoFactorBackupCode'

const joinSql = (call: unknown[]) =>
  (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv(
    'KUN_TWO_FACTOR_BACKUP_PEPPER',
    'test-only-two-factor-backup-pepper-1234567890'
  )
  executeRawMock.mockResolvedValue(1)
})

describe('2FA backup code storage', () => {
  it('hashes codes deterministically without changing the user-visible code', () => {
    const hashed = hashTwoFactorBackupCode('123456')

    expect(hashed).toMatch(/^h1:[0-9a-f]{64}$/)
    expect(hashed).not.toContain('123456')
    expect(hashTwoFactorBackupCode('123456')).toBe(hashed)
    expect(isHashedTwoFactorBackupCode(hashed)).toBe(true)
    expect(isHashedTwoFactorBackupCode('123456')).toBe(false)
  })

  it('atomically accepts and removes both migrated hashes and legacy plaintext', async () => {
    const hashed = hashTwoFactorBackupCode('123456')

    await expect(consumeTwoFactorBackupCode(7, '123456')).resolves.toBe(true)

    expect(executeRawMock.mock.calls[0].slice(1)).toEqual([
      '123456',
      hashed,
      7,
      '123456',
      hashed
    ])

    const sql = joinSql(executeRawMock.mock.calls[0])
    expect(sql).toContain('AND enable_2fa = true')
    expect(sql).toContain('= ANY(two_factor_backup)')
  })

  it('returns false when no backup code matches', async () => {
    executeRawMock.mockResolvedValue(0)

    await expect(consumeTwoFactorBackupCode(7, '123456')).resolves.toBe(false)
  })
})
