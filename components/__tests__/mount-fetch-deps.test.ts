import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 这些列表容器的首屏都由 page.tsx 用相同参数取好 initial* props 水合。
// fetch effect 的依赖一旦含 isMounted, useMounted 翻转就会让 effect 重跑, 对首屏
// 发一次与 SSR 完全相同的请求 (message 容器还会让 loading 骨架整体替换已渲染列表)。
// c551e0bd 曾把 message/Container 的 [page] 改成 [isMounted, page], admin/report
// 自建功能起就带着 isMounted。正确形态是体内 !isMounted 早退 + 依赖数组不含 isMounted。
// 无 SSR 数据、纯客户端首取的组件 (如 settings/user/appeal) 不在此列。
const containers = [
  '../message/Container.tsx',
  '../message/chat/ConversationList.tsx',
  '../admin/appeal/Container.tsx',
  '../admin/comment/Container.tsx',
  '../admin/creator/Container.tsx',
  '../admin/feedback/Container.tsx',
  '../admin/galgame/Container.tsx',
  '../admin/log/Container.tsx',
  '../admin/moderation/Container.tsx',
  '../admin/rating/Container.tsx',
  '../admin/report/Container.tsx',
  '../admin/resource-apply/Container.tsx',
  '../admin/resource/Container.tsx',
  '../admin/user/Container.tsx'
]

const fetchEffectPattern =
  /useEffect\(\(\) => \{\s*if \(!isMounted\) \{\s*return\s*\}[\s\S]*?\}, \[([^\]]*)\]\)/g

describe('initial* 水合的列表容器, fetch effect 不得因 isMounted 翻转而重跑', () => {
  it.each(containers)('%s 的依赖数组不含 isMounted', (file) => {
    const source = readFileSync(
      fileURLToPath(new URL(file, import.meta.url)),
      'utf-8'
    )
    const matches = [...source.matchAll(fetchEffectPattern)]
    expect(
      matches.length,
      '应存在以 !isMounted 早退开头的 fetch effect'
    ).toBeGreaterThan(0)

    for (const match of matches) {
      const deps = match[1].split(',').map((dep) => dep.trim())
      expect(deps).not.toContain('isMounted')
    }
  })
})

// initial* 已随 SSR 下发, 渲染层再按 !isMounted 返回骨架会让列表推迟到水合 + 一次重渲染后才可见
// (C58: 1x CPU 晚 43~61ms, 4x CPU 晚 260~376ms); isMounted 只用于跳过首屏 fetch
const renderGatePattern = /^\s*if \(!isMounted\) \{\s*return \(/m

describe('initial* 水合的列表容器, 首屏渲染不得被 isMounted 门控', () => {
  it.each(containers)('%s 不在渲染层按 !isMounted 返回占位', (file) => {
    const source = readFileSync(
      fileURLToPath(new URL(file, import.meta.url)),
      'utf-8'
    )
    expect(source).not.toMatch(renderGatePattern)
  })
})
