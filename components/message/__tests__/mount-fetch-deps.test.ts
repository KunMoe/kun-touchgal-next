import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 两个消息列表容器的首屏都由 page.tsx 用相同参数取好 initial* props 水合。
// fetch effect 的依赖一旦含 isMounted, useMounted 翻转就会让 effect 重跑, 对首屏
// 发一次与 SSR 完全相同的请求, 期间 loading 骨架还会整体替换已渲染的列表
// (c551e0bd 曾把 [page] 改成 [isMounted, page] 引入过这次回归)。
// 正确形态是体内 !isMounted 早退 + 依赖数组不含 isMounted。
const containers = ['../Container.tsx', '../chat/ConversationList.tsx']

const fetchEffectPattern =
  /useEffect\(\(\) => \{\s*if \(!isMounted\) \{\s*return\s*\}[\s\S]*?\}, \[([^\]]*)\]\)/

describe('消息列表容器的 fetch effect 不得因 isMounted 翻转而重跑', () => {
  it.each(containers)('%s 的依赖数组不含 isMounted', (file) => {
    const source = readFileSync(
      fileURLToPath(new URL(file, import.meta.url)),
      'utf-8'
    )
    const match = source.match(fetchEffectPattern)
    expect(match, '应存在以 !isMounted 早退开头的 fetch effect').not.toBeNull()

    const deps = match![1].split(',').map((dep) => dep.trim())
    expect(deps).not.toContain('isMounted')
  })
})
