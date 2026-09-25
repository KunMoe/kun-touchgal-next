import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// /[id] 访问过的资源 / 讨论 / 评价 tab 切走后保活: 切回不重拉、不闪 spinner, 评论页码、
// 草稿与评价滚动进度都在. HeroUI Tabs 默认 destroyInactiveTabPanel, 曾让 mountedTabs
// 形同虚设 (C13). 但只翻开这个开关是负收益: Next 16.3 里 ?tab= 的同步是 SyncLane,
// 订阅 useSearchParams / useRouter 的保活面板会在每次点击里被同步重渲染 (热门 patch
// 上 tab 点击 INP 56 → 128ms). 以下几处任何一处退回, 保活都会变成回归
const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

const tabsSource = readSource('../Tabs.tsx')

describe('详情页 tabs 保活', () => {
  it('不卸载未选中的面板', () => {
    expect(tabsSource).toContain('destroyInactiveTabPanel={false}')
  })

  // 保活会让已播放的 PV 视频隐藏后继续播放 (3000+ 个 patch 的简介带 ::kun-video)
  it('简介切走即卸载', () => {
    expect(tabsSource).toMatch(
      /selected === 'introduction' && \(\s*<IntroductionTab/
    )
    expect(tabsSource).not.toContain("mountedTabs.has('introduction')")
  })

  it.each(['resources', 'comments', 'rating'])(
    '%s 首次访问才挂载, 之后保活',
    (key) => {
      expect(tabsSource).toContain(`mountedTabs.has('${key}')`)
    }
  )
})

describe('保活面板不随 URL 变化重渲染', () => {
  it.each([
    '../../comment/Comments.tsx',
    '../../rating/Ratings.tsx',
    '../../resource/Tabs.tsx'
  ])('%s 不订阅 useSearchParams / useRouter', (file) => {
    const source = readSource(file)
    expect(source).not.toMatch(/\buseSearchParams\b/)
    expect(source).not.toMatch(/import \{[^}]*\buseRouter\b[^}]*\} from/)
  })

  it.each([
    ['../../resource/ResourceTab.tsx', 'ResourceTab'],
    ['../../comment/CommentTab.tsx', 'CommentTab'],
    ['../../rating/RatingTab.tsx', 'RatingTab'],
    ['../../introduction/IntroductionTab.tsx', 'IntroductionTab']
  ])('%s 以 memo 导出', (file, name) => {
    expect(readSource(file)).toContain(
      `export const ${name} = memo(function ${name}(`
    )
  })

  it('传给资源 tab 的回调引用稳定', () => {
    expect(tabsSource).toContain('const handleResourcesLoaded = useCallback(')
  })

  // 目标在 props 里一直保留 (见 tabTargets.ts), 定位若每次依赖变化都重跑,
  // 翻页、发评论、加载更多都会把页面拽回目标
  it.each([
    ['../../comment/Comments.tsx', 'scrolledCommentIdRef'],
    ['../../rating/Ratings.tsx', 'scrolledRatingIdRef'],
    ['../../resource/Tabs.tsx', 'scrolledResourceIdRef'],
    ['../../resource/Tabs.tsx', 'locatedSectionTargetRef']
  ])('%s 同一深链目标只定位一次 (%s)', (file, ref) => {
    expect(readSource(file)).toContain(`${ref}.current === `)
  })
})

describe('KunMasonry 在隐藏面板里不丢布局', () => {
  // 否则切回评价 tab 先画一帧空白, 高度塌成 0 还会让哨兵进入视口自动多拉一页
  it('忽略 0 宽的尺寸变化', () => {
    expect(readSource('../../../kun/KunMasonry.tsx')).toMatch(
      /if \(width === 0\) \{\s*return\s*\}\s*setContainerWidth\(width\)/
    )
  })
})
