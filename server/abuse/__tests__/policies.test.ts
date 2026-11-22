import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KUN_ABUSE_POLICIES } from '~/server/abuse/policies'
import type { KunAbusePolicy } from '~/server/abuse/policies'

const policies = Object.entries(KUN_ABUSE_POLICIES) as [
  string,
  KunAbusePolicy
][]

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

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

  // 没有入口引用的行是死配置: 看起来有预算, 其实什么都没管住
  it('每一行都至少被一处入口或属主引用', () => {
    const sources = globSync('{app,server}/**/*.ts', { cwd: repoRoot })
      .filter(
        (file) =>
          !file.includes('__tests__') && file !== 'server/abuse/policies.ts'
      )
      .map((file) => readFileSync(`${repoRoot}/${file}`, 'utf-8'))
      .join('\n')

    const unused = policies
      .map(([name]) => name)
      .filter((name) => !sources.includes(`'${name}'`))
    expect(unused).toEqual([])
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
