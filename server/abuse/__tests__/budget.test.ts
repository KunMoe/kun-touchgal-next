import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { evalKvScriptMock } = vi.hoisted(() => ({
  evalKvScriptMock: vi.fn()
}))

vi.mock('~/lib/redis', () => ({ evalKvScript: evalKvScriptMock }))

import {
  kunAbuseGate,
  kunAbuseMessage,
  reserveAbuseBudget
} from '~/server/abuse/budget'
import { KUN_ABUSE_POLICIES } from '~/server/abuse/policies'

// 计数脚本的语义在真 Redis 上测 (windowCounter.redis.test.ts); 这里看策略怎么变成键与参数,
// 以及豁免、失败取向和文案

const user = { uid: 7, role: 1 }
const admin = { uid: 3, role: 3 }

const callOf = (index = 0) => {
  const [, keys, args] = evalKvScriptMock.mock.calls[index] as [
    string,
    string[],
    Array<string | number>
  ]
  return { keys, args }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ now: new Date('2026-11-22T23:30:00.000Z') })
  evalKvScriptMock.mockResolvedValue([1, 9, 99])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reserveAbuseBudget', () => {
  it('builds one group per charge: UTC-dated stats key, override key, then a key per window', async () => {
    await expect(
      reserveAbuseBudget([{ policy: 'content.comment' }], user)
    ).resolves.toBeNull()

    const { keys, args } = callOf()
    const windows = KUN_ABUSE_POLICIES['content.comment'].windows
    expect(keys).toEqual([
      'abuse:stats:content.comment:2026-11-22',
      'abuse:override:content.comment',
      ...windows.map(
        (window) => `abuse:content.comment:uid:7:${window.windowSeconds}`
      )
    ])
    // 没有 guard; 一组: 窗口数, cost 1, 观察期不 enforce, 有统计 (8 天), 有止损键
    expect(args.slice(0, 9)).toEqual([
      0,
      '',
      1,
      windows.length,
      1,
      0,
      1,
      8 * 24 * 60 * 60,
      1
    ])
    expect(args.slice(9)).toEqual(
      windows.flatMap((window) => [window.limit, window.windowSeconds, 0])
    )
  })

  it('keys global windows by the whole site and passes the cost through', async () => {
    await reserveAbuseBudget(
      [{ policy: 'notify.mention', cost: 12 }, { policy: 'upstream.moyu' }],
      user
    )

    const { keys, args } = callOf()
    expect(keys).toContain('abuse:notify.mention:uid:7:86400')
    expect(keys).toContain('abuse:upstream.moyu:global:all:60')
    // 第一组的 cost
    expect(args[4]).toBe(12)
  })

  it('does not charge a subject the policy exempts, but still charges shared upstream quotas', async () => {
    await expect(
      reserveAbuseBudget([{ policy: 'content.comment' }], admin)
    ).resolves.toBeNull()
    expect(evalKvScriptMock).not.toHaveBeenCalled()

    await reserveAbuseBudget(
      [{ policy: 'external.fetch' }, { policy: 'upstream.vndb' }],
      admin
    )
    expect(callOf().keys).toEqual([
      expect.stringMatching(/^abuse:stats:upstream\.vndb:/),
      'abuse:override:upstream.vndb',
      'abuse:upstream.vndb:global:all:300'
    ])
  })

  it('lets an anonymous caller be charged only on global windows', async () => {
    await reserveAbuseBudget([{ policy: 'upstream.moyu' }], 'anonymous')
    expect(callOf().keys).toContain('abuse:upstream.moyu:global:all:60')

    await expect(
      reserveAbuseBudget([{ policy: 'content.comment' }], 'anonymous')
    ).rejects.toThrow('anonymous')
  })

  it('names the policy and the kind of window that refused', async () => {
    // 第二组 (upstream.vndb) 的第一个窗口, 展开后下标 3: external.fetch 有两个窗口
    evalKvScriptMock.mockResolvedValue([2, 3, 2, 125_000])

    await expect(
      reserveAbuseBudget(
        [{ policy: 'external.fetch' }, { policy: 'upstream.vndb' }],
        user
      )
    ).resolves.toEqual({
      policy: 'upstream.vndb',
      per: 'global',
      retryAfterSec: 125
    })
  })

  it('lets the request through and warns when Redis fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    evalKvScriptMock.mockRejectedValue(new Error('redis down'))

    await expect(
      reserveAbuseBudget([{ policy: 'content.comment' }], user)
    ).resolves.toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('kunAbuseGate', () => {
  it('returns null when allowed and the message when refused', async () => {
    await expect(kunAbuseGate(['content.comment'], user)).resolves.toBeNull()

    evalKvScriptMock.mockResolvedValue([2, 1, 1, 179_100])
    await expect(kunAbuseGate(['content.comment'], user)).resolves.toBe(
      '操作过于频繁, 请 3 分钟后再试'
    )
  })
})

describe('kunAbuseMessage', () => {
  it.each([
    [{ per: 'uid', retryAfterSec: 42 }, '操作过于频繁, 请 42 秒后再试'],
    [{ per: 'uid', retryAfterSec: 60 }, '操作过于频繁, 请 1 分钟后再试'],
    [{ per: 'uid', retryAfterSec: 3599 }, '操作过于频繁, 请 60 分钟后再试'],
    [{ per: 'uid', retryAfterSec: 50_000 }, '操作过于频繁, 请 14 小时后再试'],
    [{ per: 'global', retryAfterSec: 30 }, '当前使用的人太多, 请 30 秒后再试']
  ] as const)('%j', (denial, message) => {
    expect(kunAbuseMessage({ policy: 'content.comment', ...denial })).toBe(
      message
    )
  })
})
