import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getKvMock, reserveAttemptMock, setKvIfAbsentMock, settleSuccessMock } =
  vi.hoisted(() => ({
    getKvMock: vi.fn(),
    reserveAttemptMock: vi.fn(),
    setKvIfAbsentMock: vi.fn(),
    settleSuccessMock: vi.fn()
  }))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKvIfAbsent: setKvIfAbsentMock
}))

vi.mock('~/server/auth/attemptBudget', () => ({
  reserveAttempt: reserveAttemptMock,
  settleSuccess: settleSuccessMock
}))

import {
  consumeTwoFactorChallenge,
  createTwoFactorChallenge,
  isTwoFactorChallengeActive,
  reserveTwoFactorAttempt
} from '~/app/api/auth/_twoFactorChallenge'

// 预留与结算的脚本语义在真 Redis 上测 (twoFactorChallenge.redis.test.ts); 这里只看
// 交给预算原语的键、阈值与 guard, 以及结果的翻译。键名是存量, 一个字都不能变

const UID_IP_KEY = /^auth:2fa:uid-ip-attempts:7:[0-9a-f]{64}$/

beforeEach(() => {
  vi.clearAllMocks()
  setKvIfAbsentMock.mockResolvedValue(true)
  reserveAttemptMock.mockResolvedValue({ allowed: true, remaining: [4, 9, 4] })
  settleSuccessMock.mockResolvedValue(true)
})

describe('2FA challenge', () => {
  it('creates a unique 10-minute challenge bound to the user', async () => {
    await createTwoFactorChallenge('challenge-id', 7)

    expect(setKvIfAbsentMock).toHaveBeenCalledWith(
      'auth:2fa:challenge:challenge-id',
      '7',
      600
    )
  })

  it('fails closed when a challenge id collision occurs', async () => {
    setKvIfAbsentMock.mockResolvedValue(false)

    await expect(createTwoFactorChallenge('challenge-id', 7)).rejects.toThrow(
      'Failed to create unique 2FA challenge'
    )
  })

  it('checks that the Redis challenge still belongs to the token subject', async () => {
    getKvMock.mockResolvedValue('7')
    await expect(isTwoFactorChallengeActive('challenge-id', 7)).resolves.toBe(
      true
    )

    getKvMock.mockResolvedValue('8')
    await expect(isTwoFactorChallengeActive('challenge-id', 7)).resolves.toBe(
      false
    )
  })

  it('reserves the challenge, uid, and ip budgets in one call, guarded by the challenge', async () => {
    await expect(
      reserveTwoFactorAttempt('challenge-id', 7, '203.0.113.8')
    ).resolves.toEqual({ allowed: true, remainingAttempts: 4 })

    expect(reserveAttemptMock).toHaveBeenCalledTimes(1)
    const [dims, guard] = reserveAttemptMock.mock.calls[0]
    expect(dims).toEqual([
      {
        key: 'auth:2fa:challenge-attempts:challenge-id',
        limit: 5,
        windowSeconds: 600,
        expiresWithGuard: true
      },
      { key: 'auth:2fa:uid-attempts:7', limit: 10, windowSeconds: 900 },
      {
        key: expect.stringMatching(UID_IP_KEY),
        limit: 5,
        windowSeconds: 900
      }
    ])
    expect(dims[2].key).not.toContain('203.0.113.8')
    expect(guard).toEqual({
      key: 'auth:2fa:challenge:challenge-id',
      expected: '7'
    })
  })

  it('reports what is left of the challenge, not of the tightest dimension', async () => {
    reserveAttemptMock.mockResolvedValue({
      allowed: true,
      remaining: [3, 0, 1]
    })

    await expect(
      reserveTwoFactorAttempt('challenge-id', 7, '203.0.113.8')
    ).resolves.toEqual({ allowed: true, remainingAttempts: 3 })
  })

  it('has no IP dimension when the client IP is unknown', async () => {
    await reserveTwoFactorAttempt('challenge-id', 7, '')

    const [dims] = reserveAttemptMock.mock.calls[0]
    expect(dims.map((dim: { key: string }) => dim.key)).toEqual([
      'auth:2fa:challenge-attempts:challenge-id',
      'auth:2fa:uid-attempts:7'
    ])
  })

  it('isolates the same IP budget by user id', async () => {
    await reserveTwoFactorAttempt('challenge-7', 7, '203.0.113.8')
    await reserveTwoFactorAttempt('challenge-8', 8, '203.0.113.8')

    const firstKey = reserveAttemptMock.mock.calls[0][0][2].key
    const secondKey = reserveAttemptMock.mock.calls[1][0][2].key
    expect(firstKey).toMatch(/^auth:2fa:uid-ip-attempts:7:/)
    expect(secondKey).toMatch(/^auth:2fa:uid-ip-attempts:8:/)
    expect(firstKey).not.toBe(secondKey)
  })

  it.each([
    [{ reason: 'guard-missing' }, 'expired'],
    [{ reason: 'guard-mismatch' }, 'invalid'],
    [
      {
        reason: 'exhausted',
        dimension: 'auth:2fa:challenge-attempts:challenge-id'
      },
      'challenge'
    ],
    [{ reason: 'exhausted', dimension: 'auth:2fa:uid-attempts:7' }, 'uid']
  ] as const)('maps %j to %s rejection', async (rejection, reason) => {
    reserveAttemptMock.mockResolvedValue({ allowed: false, ...rejection })

    await expect(
      reserveTwoFactorAttempt('challenge-id', 7, '203.0.113.8')
    ).resolves.toEqual({ allowed: false, reason })
  })

  it('maps an exhausted IP dimension to uidIp rejection', async () => {
    reserveAttemptMock.mockImplementation(async (dims: { key: string }[]) => ({
      allowed: false,
      reason: 'exhausted',
      dimension: dims[2].key
    }))

    await expect(
      reserveTwoFactorAttempt('challenge-id', 7, '203.0.113.8')
    ).resolves.toEqual({ allowed: false, reason: 'uidIp' })
  })

  it('consumes the challenge together with the counters of the succeeding request', async () => {
    await expect(
      consumeTwoFactorChallenge('challenge-id', 7, '203.0.113.8')
    ).resolves.toBe(true)

    const [dims, guard] = settleSuccessMock.mock.calls[0]
    expect(dims.map((dim: { key: string }) => dim.key)).toEqual([
      'auth:2fa:challenge-attempts:challenge-id',
      'auth:2fa:uid-attempts:7',
      expect.stringMatching(UID_IP_KEY)
    ])
    expect(guard).toEqual({
      key: 'auth:2fa:challenge:challenge-id',
      expected: '7'
    })
  })

  it('reports a challenge that was already consumed or is not ours', async () => {
    settleSuccessMock.mockResolvedValue(false)

    await expect(
      consumeTwoFactorChallenge('challenge-id', 7, '')
    ).resolves.toBe(false)
  })
})
