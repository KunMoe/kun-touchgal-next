import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Patch, PatchIntroduction } from '~/types/api/patch'

vi.mock('~/components/patch/header/Tabs', () => ({
  PatchHeaderTabs: () => null
}))
vi.mock('~/components/patch/header/Info', () => ({
  PatchHeaderInfo: () => null
}))
vi.mock('~/components/patch/header/ClientEffects', () => ({
  PatchHeaderClientEffects: () => null
}))
vi.mock('~/components/kun/image-viewer/AutoImageViewer', () => ({
  KunAutoImageViewer: () => null
}))

const { PatchHeaderContainer } =
  await import('~/components/patch/header/Container')
const { PatchHeaderTabs } = await import('~/components/patch/header/Tabs')
const { PatchHeaderInfo } = await import('~/components/patch/header/Info')
const { PatchHeaderClientEffects } =
  await import('~/components/patch/header/ClientEffects')

// /[id] 的 patch 与 intro 会进 Flight 载荷, 给每个访客下发一份 (C54).
// markdown 原文与 tags 客户端用不到: 重写页 /edit/rewrite/[uniqueId] 自己读库, 不再由
// 详情页替它预填; intro.tag 只有登录用户可见.
// 匿名 HTML gz 中位 -809B (3.9%), role<3 -295B
const MARKDOWN = '# kun\n\n![](https://example.com/a.webp)\n\n简介原文'

const createPatch = (): Patch => ({
  id: 1,
  uniqueId: 'abcdefgh',
  vndbId: 'v1',
  vndbRelationId: null,
  bangumiId: null,
  steamId: null,
  dlsiteCode: null,
  name: 'kun',
  banner: 'https://example.com/banner.avif',
  introduction: MARKDOWN,
  status: 0,
  view: 1,
  download: 1,
  alias: ['别名'],
  type: ['pc'],
  language: ['zh-Hans'],
  platform: ['windows'],
  tags: ['标签甲', '标签乙'],
  isFavorite: false,
  contentLimit: 'sfw',
  ratingSummary: {
    average: 0,
    count: 0,
    histogram: [],
    recommend: { strong_no: 0, no: 0, neutral: 0, yes: 0, strong_yes: 0 }
  },
  user: { id: 2, name: 'moe', avatar: '' },
  created: '2026-01-01',
  updated: '2026-01-01',
  _count: { favorite_folder: 0, resource: 0, comment: 0 }
})

const createIntro = (): PatchIntroduction => ({
  vndbId: 'v1',
  introduction: '<h1>kun</h1><p>简介原文</p>',
  released: '2026-01-01',
  alias: ['别名'],
  tag: [
    { id: 11, name: '标签甲', count: 3, alias: ['tag-a'] },
    { id: 12, name: '标签乙', count: 4, alias: [] }
  ],
  company: [],
  resourceUpdateTime: '2026-01-01',
  created: '2026-01-01',
  updated: '2026-01-01'
})

const collect = (node: ReactNode, out: ReactElement[] = []) => {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out))
  } else if (isValidElement<{ children?: ReactNode }>(node)) {
    out.push(node)
    collect(node.props.children, out)
  }
  return out
}

const render = (options: { uid?: number } = {}) => {
  const patch = createPatch()
  const intro = createIntro()
  const elements = collect(
    PatchHeaderContainer({ patch, intro, nsfwAllowed: true, ...options })
  )
  const propsOf = (type: unknown) => {
    const element = elements.find((el) => el.type === type)
    expect(element).toBeDefined()
    return element!.props as Record<string, unknown>
  }
  return {
    patch,
    intro,
    effects: propsOf(PatchHeaderClientEffects),
    info: propsOf(PatchHeaderInfo),
    tabs: propsOf(PatchHeaderTabs)
  }
}

describe('/[id] 客户端 props 裁剪', () => {
  it('客户端组件共用同一个 patch 引用, 否则 Flight 会序列化两份', () => {
    const { effects, info } = render({ uid: 2 })
    expect(effects.patch).toBe(info.patch)
  })

  it.each([
    ['匿名', undefined],
    ['登录用户', 2]
  ])('%s: patch 上不带 markdown 原文与 tags', (_, uid) => {
    const { effects } = render({ uid })
    expect(effects.patch).toMatchObject({ introduction: '', tags: [] })
  })

  // 详情页不认角色: 能进重写页的管理员在这里拿到的也是同一份裁剪过的载荷
  it('任何角色的客户端 props 都不含 markdown 原文与 patch.tags', () => {
    for (const uid of [undefined, 2]) {
      const { effects, info, tabs } = render({ uid })
      expect(Object.keys(effects).sort()).toEqual(['isNsfwBlocked', 'patch'])
      const payload = JSON.stringify([effects, info, tabs])
      expect(payload).not.toContain(JSON.stringify(MARKDOWN))
      expect(payload).not.toContain('![](')
      // 标签名只可能经 intro.tag (登录后的标签页签) 出现, 不在 patch 上
      expect(JSON.stringify([effects, info])).not.toContain('标签甲')
    }
  })

  it('匿名不下发 intro.tag, 登录后原样下发', () => {
    const anonymous = render()
    expect(anonymous.tabs.intro).toMatchObject({ tag: [] })
    expect(JSON.stringify(anonymous.tabs)).not.toContain('标签甲')

    const loggedIn = render({ uid: 2 })
    expect(loggedIn.tabs.intro).toBe(loggedIn.intro)
  })

  // cache() 返回的对象与 generateMetadata 共用
  it('不原地修改传入的 patch 与 intro', () => {
    const { patch, intro } = render()
    expect(patch).toEqual(createPatch())
    expect(intro).toEqual(createIntro())
  })
})
