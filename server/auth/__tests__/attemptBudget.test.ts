import { beforeEach, describe, expect, it, vi } from 'vitest'

const { evalKvScriptMock } = vi.hoisted(() => ({
  evalKvScriptMock: vi.fn()
}))

vi.mock('~/lib/redis', () => ({ evalKvScript: evalKvScriptMock }))

import { reserveAttempt, settleSuccess } from '~/server/auth/attemptBudget'

// 脚本本身的语义在真 Redis 上测 (attemptBudget.redis.test.ts); 这里只看交给脚本的键与参数,
// 以及回复的翻译

const wide = { key: 'budget:wide', limit: 10, windowSeconds: 900 }
const scoped = {
  key: 'budget:scoped',
  limit: 5,
  windowSeconds: 600,
  expiresWithGuard: true
}
const guard = { key: 'budget:guard', expected: '7' }

beforeEach(() => {
  vi.resetAllMocks()
})

describe('reserveAttempt', () => {
  it('passes the dimension keys first, the guard key last, and three arguments per dimension', async () => {
    evalKvScriptMock.mockResolvedValue([1, 4, 9])

    await expect(reserveAttempt([scoped, wide], guard)).resolves.toEqual({
      allowed: true,
      remaining: [4, 9]
    })

    const [, keys, args] = evalKvScriptMock.mock.calls[0]
    expect(keys).toEqual(['budget:scoped', 'budget:wide', 'budget:guard'])
    expect(args).toEqual([2, '7', 5, 600, 1, 10, 900, 0])
  })

  it('sends no guard key when there is no guard', async () => {
    evalKvScriptMock.mockResolvedValue([1, 9])

    await reserveAttempt([wide])

    const [, keys, args] = evalKvScriptMock.mock.calls[0]
    expect(keys).toEqual(['budget:wide'])
    expect(args).toEqual([1, '', 10, 900, 0])
  })

  it.each([
    [[0], { allowed: false, reason: 'guard-missing' }],
    [[-1], { allowed: false, reason: 'guard-mismatch' }],
    [
      [2, 1],
      { allowed: false, reason: 'exhausted', dimension: 'budget:scoped' }
    ],
    [[2, 2], { allowed: false, reason: 'exhausted', dimension: 'budget:wide' }]
  ])('translates the reply %j', async (reply, expected) => {
    evalKvScriptMock.mockResolvedValue(reply)

    await expect(reserveAttempt([scoped, wide], guard)).resolves.toEqual(
      expected
    )
  })

  // 没有维度就没有上限: 漏传不能变成可以无限次尝试
  it('refuses to run without any dimension', async () => {
    await expect(reserveAttempt([])).rejects.toThrow(
      'attempt budget needs at least one dimension'
    )
    expect(evalKvScriptMock).not.toHaveBeenCalled()
  })

  it('lets a Redis failure surface', async () => {
    evalKvScriptMock.mockRejectedValue(new Error('redis unavailable'))

    await expect(reserveAttempt([wide])).rejects.toThrow('redis unavailable')
  })
})

describe('settleSuccess', () => {
  it('reports whether the guard was still ours', async () => {
    evalKvScriptMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0)

    await expect(settleSuccess([scoped, wide], guard)).resolves.toBe(true)
    await expect(settleSuccess([scoped, wide], guard)).resolves.toBe(false)

    const [, keys, args] = evalKvScriptMock.mock.calls[0]
    expect(keys).toEqual(['budget:scoped', 'budget:wide', 'budget:guard'])
    expect(args).toEqual([2, '7'])
  })
})
