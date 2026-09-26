import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// /[id]?tab=resources 深链首次加载时, 资源面板还只是 256px 的懒加载占位:
// 水合即滚会因页面不够长停在半路 (移动端 tabs 距顶 265px), 随后「占位 → 空列表 →
// spinner → 列表」反复推动已滚进视口的页脚 (移动端 CLS 0.10–0.15). 改为列表渲染
// 完成后再滚, 并去掉空列表那一帧. 任何一处退回, 深链 CLS 都会回到 0.1 以上
const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

const tabsSource = readSource('../Tabs.tsx')
const resourceTabSource = readSource('../../resource/ResourceTab.tsx')
const resourcesSource = readSource('../../resource/Resource.tsx')

describe('资源深链在列表渲染完成后才滚动', () => {
  // 同文档后退还原资源视图时不滚 (R2-C12), 另见 resource-view-restore.test.ts
  it('首次落在资源 tab 时跳过水合即滚', () => {
    expect(tabsSource).toMatch(
      /const pendingResourceScrollRef = useRef\(\s*selected === 'resources' && !isResourceViewRestore\s*\)/
    )
    expect(tabsSource).toMatch(
      /hasTabDeepLink\(searchParams\) &&[\s\S]{0,160}?!\(nextTab === 'resources' && pendingResourceScrollRef\.current\)/
    )
  })

  // 列表加载完成前切到别的 tab, 保活的资源面板随后加载完成仍会调 onLoaded,
  // 标记不清就会把正在看讨论版 / 评价的用户拉回 tabs
  it('选中 tab 离开资源时清掉待滚动标记', () => {
    const effect = tabsSource.match(
      /useEffect\(\(\) => \{\s*const nextTab = getSelectedTab\(searchParams\)([\s\S]*?)\}, \[searchParams\]\)/
    )?.[1]
    expect(effect).toBeDefined()
    expect(effect).toMatch(
      /if \(nextTab !== 'resources'\) \{\s*pendingResourceScrollRef\.current = false\s*\}/
    )
  })

  it('列表加载完成的回调一路传到 Resources', () => {
    expect(tabsSource).toContain('onLoaded={handleResourcesLoaded}')
    expect(resourceTabSource).toContain('onLoaded={onLoaded}')
  })

  // passive effect 里调用会晚于 ResourceTabs 滚到 resourceId 卡片, 把它覆盖回 tabs
  it('onLoaded 在 layout effect 里调用', () => {
    expect(resourcesSource).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!loading\) \{\s*onLoaded\?\.\(\)/
    )
  })
})

describe('资源列表挂载首帧不画空列表', () => {
  it('Resources 的 loading 初值为 true', () => {
    expect(resourcesSource).toContain(
      'const [loading, setLoading] = useState(true)'
    )
  })
})
