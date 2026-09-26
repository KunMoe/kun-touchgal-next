import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// /[id] 点「资源链接」或「下载」到资源列表出现, 曾被三件事串行拖住:
// 1. router.replace / router.push 只为改 ?tab= 却要取回整页 RSC, 且每次让浏览量 +1
// 2. 资源 tab 是 ssr:false 懒加载, 点击后才下载
// 3. 同步 lane 挂载懒组件会先提交 fallback, React 19 把随后的揭示推迟到 300ms
// 只有 history API + 与 dynamic 共用同一 import() 的预热 + startTransition 挂载
// 三者同时成立, 预热命中时才不出 fallback. 任何一处退回, 10Mbps 下点击到首卡
// 都会从约 95ms 退回约 390ms
const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

const tabsSource = readSource('../Tabs.tsx')
const actionsSource = readSource('../Actions.tsx')

const RESOURCE_TAB_IMPORT = "import('~/components/patch/resource/ResourceTab')"

describe('/[id] 改 ?tab= 不走服务端导航', () => {
  it('切 tab 用 history.replaceState', () => {
    expect(tabsSource).not.toContain('router.replace(')
    expect(tabsSource).toContain('window.history.replaceState(')
  })

  it('「下载」用 history.pushState', () => {
    const handler = actionsSource.match(
      /const handleClickDownloadNav = \(\) => \{([\s\S]*?)\n {2}\}/
    )?.[1]
    expect(handler).toBeDefined()
    expect(handler).toContain('window.history.pushState(')
    expect(handler).not.toContain('router.push(')
  })

  // 已在资源 tab 时目标地址与当前相同; pushState 不像 router.push 那样同址去重,
  // 会多出一条同址历史记录, 用户第一次后退「没反应」
  it('「下载」目标地址与当前相同时不 pushState', () => {
    const handler = actionsSource.match(
      /const handleClickDownloadNav = \(\) => \{([\s\S]*?)\n {2}\}/
    )?.[1]
    expect(handler).toMatch(
      /if \(query === searchParams\.toString\(\)\) \{\s*return\s*\}[\s\S]*window\.history\.pushState\(/
    )
  })
})

describe('资源 tab 预热命中 dynamic 且不出 fallback', () => {
  it('ResourceTab 只有一处 import(), 位于共用 loader', () => {
    expect(tabsSource.split(RESOURCE_TAB_IMPORT)).toHaveLength(2)
    expect(tabsSource).toContain(
      `const loadResourceTab = () => ${RESOURCE_TAB_IMPORT}`
    )
  })

  it('dynamic 与挂载预热都调用 loadResourceTab()', () => {
    expect(tabsSource).toMatch(
      /const ResourceTab = dynamic\(\s*\(\) => loadResourceTab\(\)/
    )
    expect(tabsSource).toMatch(
      /useEffect\(\(\) => \{\s*void loadResourceTab\(\)\s*\}, \[\]\)/
    )
  })

  it('挂载 tab 的状态更新都在 startTransition 里', () => {
    const mounts = tabsSource.match(/setMountedTabs\(/g) ?? []
    const wrapped =
      tabsSource.match(
        /startTransition\(\(\) => \{\s*setSelected\(nextTab\)\s*setMountedTabs\(/g
      ) ?? []
    expect(mounts.length).toBeGreaterThan(0)
    expect(wrapped).toHaveLength(mounts.length)
  })
})
