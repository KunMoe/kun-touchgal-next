import { describe, expect, it } from 'vitest'
import { KUN_ABUSE_POLICIES } from '~/server/abuse/policies'
import type { KunAbusePolicy } from '~/server/abuse/policies'

const policies = Object.entries(KUN_ABUSE_POLICIES) as [
  string,
  KunAbusePolicy
][]

describe('频率预算表', () => {
  it.each(policies)('%s 的窗口都是正整数, 同一行里不重键', (_name, policy) => {
    expect(policy.windows.length).toBeGreaterThan(0)
    for (const window of policy.windows) {
      expect(Number.isSafeInteger(window.limit) && window.limit > 0).toBe(true)
      expect(
        Number.isSafeInteger(window.windowSeconds) && window.windowSeconds > 0
      ).toBe(true)
    }
    // 键由 (per, 窗口秒数) 区分: 两个窗口撞键会互相计数
    const keys = policy.windows.map(
      (window) => `${window.per}:${window.windowSeconds}`
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  // 上游配额按本站出口计: 不分账号、不豁免任何人; moyu 对游客开放, 也只能这样计
  it('upstream.* 只有全站窗口, 不豁免任何人', () => {
    const upstream = policies.filter(([name]) => name.startsWith('upstream.'))
    expect(upstream.length).toBeGreaterThan(0)
    for (const [name, policy] of upstream) {
      expect(policy.exempt, name).toBeNull()
      expect(
        policy.windows.every((window) => window.per === 'global'),
        name
      ).toBe(true)
    }
  })
})
