import { createRequire } from 'module'
import { readFileSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'

// Next 首次水合时 prefetchRsc 为 null, layout-router / app-router(Head) 实际调用
// useDeferredValue(x, x). React 仍为它派生 deferred lane, 且不与 hydration lane 纠缠:
// 根水合若因段级 chunk (页面或 app/error) 晚到而挂起, 这条 lane 会单独提交空根并清空
// suspendedLanes, 水合随即重启, 循环直到 chunk 到达 (1.6Mbps 冷加载 script 多 40–250ms).
// patches/next@16.3.5.patch 在两值相同时不传 initialValue, 值相同的 deferred 渲染本就是
// no-op, 语义不变. 上游 react/react#37682 (修复 PR #37689)
const resolveNextRoot = () => {
  const require = createRequire(import.meta.url)
  return dirname(realpathSync(require.resolve('next/package.json')))
}

describe('Next 首次水合不派生 useDeferredValue 的 deferred lane', () => {
  const root = resolveNextRoot()

  it('解析到的仍是被 patch 的 next 16.3.5', () => {
    const { version } = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8')
    )
    // 升级 Next 须重新评估: 其内置 React 已含 #37689 的修复则删 patch 与本测试, 否则重做
    expect(version).toBe('16.3.5')
  })

  it.each([
    ['dist/client/components/layout-router.js', 'cacheNode.rsc'],
    ['dist/esm/client/components/layout-router.js', 'cacheNode.rsc'],
    ['dist/client/components/app-router.js', 'head'],
    ['dist/esm/client/components/app-router.js', 'head']
  ])('%s 在初值与终值相同时不传 initialValue', (file, value) => {
    const source = readFileSync(join(root, file), 'utf8')
    expect(source).toContain(
      `useDeferredValue${file.includes('/esm/') ? '' : ')'}(${value}, resolvedPrefetchRsc === ${value} ? undefined : resolvedPrefetchRsc);`
    )
    expect(source).not.toContain(`(${value}, resolvedPrefetchRsc);`)
  })
})
