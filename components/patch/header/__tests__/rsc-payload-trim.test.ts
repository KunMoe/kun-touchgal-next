import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
// markdown 原文与 tags 只给 role≥3 的 /edit/rewrite 预填; intro.tag 只有登录用户可见.
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

const render = (options: { uid?: number; canRewrite: boolean }) => {
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
    const { effects, info } = render({ uid: 2, canRewrite: true })
    expect(effects.patch).toBe(info.patch)
  })

  it.each([
    ['匿名', undefined, false],
    ['role<3', 2, false],
    ['role≥3', 2, true]
  ])('%s: patch 上不带 markdown 原文与 tags', (_, uid, canRewrite) => {
    const { effects } = render({ uid, canRewrite })
    expect(effects.patch).toMatchObject({ introduction: '', tags: [] })
  })

  it('非管理员的客户端 props 不含 markdown 原文', () => {
    for (const uid of [undefined, 2]) {
      const { effects, info, tabs } = render({ uid, canRewrite: false })
      expect(effects.rewrite).toBeNull()
      const payload = JSON.stringify([effects, info, tabs])
      expect(payload).not.toContain(JSON.stringify(MARKDOWN))
      expect(payload).not.toContain('![](')
    }
  })

  it('role≥3 经 rewrite 拿到预填所需的原文与 tags', () => {
    const { effects } = render({ uid: 2, canRewrite: true })
    expect(effects.rewrite).toEqual({
      introduction: MARKDOWN,
      tags: ['标签甲', '标签乙']
    })
  })

  it('匿名不下发 intro.tag, 登录后原样下发', () => {
    const anonymous = render({ canRewrite: false })
    expect(anonymous.tabs.intro).toMatchObject({ tag: [] })
    expect(JSON.stringify(anonymous.tabs)).not.toContain('标签甲')

    const loggedIn = render({ uid: 2, canRewrite: false })
    expect(loggedIn.tabs.intro).toBe(loggedIn.intro)
  })

  // cache() 返回的对象与 generateMetadata 共用
  it('不原地修改传入的 patch 与 intro', () => {
    const { patch, intro } = render({ canRewrite: false })
    expect(patch).toEqual(createPatch())
    expect(intro).toEqual(createIntro())
  })
})

const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

describe('/edit/rewrite 预填来源', () => {
  const effectsSource = readSource('../ClientEffects.tsx')

  it('store 的原文与 tags 只取自 rewrite', () => {
    expect(effectsSource).not.toContain('patch.introduction')
    expect(effectsSource).not.toContain('patch.tags')
    expect(effectsSource).toContain('introduction: rewrite.introduction')
    expect(effectsSource).toContain('tag: rewrite.tags')
  })

  // 用空值 setData 会让 PUT /edit 的全量同步删光该 patch 的标签
  it('无 rewrite 时清空 store 而不是用空值预填', () => {
    expect(effectsSource).toMatch(
      /if \(!rewrite\) \{\s*resetData\(\)\s*return\s*\}/
    )
  })

  it('下发门槛与 /edit/rewrite 的准入一致', () => {
    expect(readSource('../../../../app/[id]/page.tsx')).toContain(
      'canRewrite={!!payload && payload.role >= 3}'
    )
    expect(readSource('../../../../app/edit/rewrite/page.tsx')).toContain(
      'if (!payload || payload.role < 3) {'
    )
  })
})
