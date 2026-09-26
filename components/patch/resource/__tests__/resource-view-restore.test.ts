import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 从 /redirect、资源详情页等同文档后退回资源 tab 时页面树会重新挂载 (R2-C12):
// 曾经位置被滚回 tabs、展开收起、分区回到 Galgame (Δ 191–6976px). 只去掉滚动不够:
// 列表是重新请求的, popstate 那一刻页面不够高, 桌面 Chrome 与 WebKit 只恢复一次滚动就被
// 截断, 比 HEAD 停得更远. 现在按离开前的列表高度占位并还原展开 / 分区, 由浏览器一次恢复到位
const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

const loadResourceView = async () => {
  vi.resetModules()
  return import('../resourceView')
}

const stubWindowEvent = (type: string) => {
  vi.stubGlobal('window', { event: { type } })
}

describe('resourceView 只在同文档后退 / 前进回到同一 patch 时还原', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('popstate 渲染回到同一 patch: 沿用离开前的分区、展开与列表高度', async () => {
    const { enterResourceView, getResourceView } = await loadResourceView()
    stubWindowEvent('message')
    expect(enterResourceView(12489)).toBe(false)
    const view = getResourceView()
    view.section = 'patch'
    view.expandedIds.add(45131)
    view.listHeight = 5000

    stubWindowEvent('popstate')
    expect(enterResourceView(12489)).toBe(true)
    expect(getResourceView()).toMatchObject({
      patchId: 12489,
      section: 'patch',
      listHeight: 5000
    })
    expect(getResourceView().expandedIds.has(45131)).toBe(true)
  })

  it.each([
    ['非 popstate 渲染 (新访问 / RSC 重新请求后才渲染)', 'message', 12489],
    ['popstate 但换了 patch', 'popstate', 868]
  ])('%s: 重置', async (_, eventType, nextPatchId) => {
    const { enterResourceView, getResourceView } = await loadResourceView()
    stubWindowEvent('message')
    enterResourceView(12489)
    getResourceView().section = 'patch'
    getResourceView().expandedIds.add(45131)
    getResourceView().listHeight = 5000

    stubWindowEvent(eventType)
    expect(enterResourceView(nextPatchId)).toBe(false)
    expect(getResourceView()).toMatchObject({
      patchId: nextPatchId,
      section: 'galgame',
      listHeight: 0
    })
    expect(getResourceView().expandedIds.size).toBe(0)
  })

  it('服务端渲染时不可还原', async () => {
    const { canRestoreResourceView } = await loadResourceView()
    expect(typeof window).toBe('undefined')
    expect(canRestoreResourceView(0)).toBe(false)
  })
})

describe('还原视图的接线', () => {
  const resourcesSource = readSource('../Resource.tsx')
  const tabsSource = readSource('../Tabs.tsx')
  const downloadSource = readSource('../ResourceDownload.tsx')
  const headerTabsSource = readSource('../../header/Tabs.tsx')

  // 只按 loading 撤占位时, 补丁分区里异步的鲲补丁还没长回来, 桌面落点被截 109px
  it('按离开前的高度占位, 列表自然高度长回来才撤', () => {
    expect(resourcesSource).toMatch(
      /reservedHeight !== null \? \{ minHeight: reservedHeight \} : undefined\s*\}\s*>\s*<div ref=\{listRef\}>/
    )
    expect(resourcesSource).toMatch(
      /current !== null && height >= current \? null : current/
    )
  })

  // 离开期间资源被删时列表不会再长回原高度, 不能一直留着空白
  it('列表加载完成后兜底撤掉占位', () => {
    expect(resourcesSource).toMatch(
      /if \(loading \|\| reservedHeight === null\) \{\s*return\s*\}\s*const timer = window\.setTimeout\(\(\) => setReservedHeight\(null\), 3000\)/
    )
  })

  it('展开与分区的初值取自 resourceView', () => {
    expect(downloadSource).toMatch(
      /useState\(\(\) =>\s*getResourceView\(\)\.expandedIds\.has\(resource\.id\)\s*\)/
    )
    expect(tabsSource).toMatch(
      /useState\(\s*\(\) => getResourceView\(\)\.section as ResourceSection\s*\)/
    )
  })

  // 深链落地后离开再后退, 不能又被拽回深链卡片并高亮
  it('还原时深链目标视为已定位', () => {
    expect(tabsSource).toMatch(
      /useRef<number \| null>\(\s*isViewRestored \? targetResourceId : null\s*\)/
    )
  })

  // 用挂载时那份 searchParams 判断而非一次性 flag: dev StrictMode 下 effect 会跑两遍
  it('还原时 header 不滚到 tabs', () => {
    expect(headerTabsSource).toMatch(
      /useState\(\s*\(\) => selected === 'resources' && canRestoreResourceView\(id\)\s*\)/
    )
    expect(headerTabsSource).toMatch(
      /!\(\s*isResourceViewRestore && searchParams === mountSearchParamsRef\.current\s*\)/
    )
  })
})
