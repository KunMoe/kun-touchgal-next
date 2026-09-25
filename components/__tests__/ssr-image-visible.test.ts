import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GalgameCard } from '~/components/galgame/Card'
import { KunAboutCard } from '~/components/doc/Card'
import { BlogHeader } from '~/components/doc/BlogHeader'
import { UserGalgameCard } from '~/components/user/favorite/Card'
import { UserResourceCard } from '~/components/user/resource/Card'
import { GalgameSummaryCard } from '~/components/patch/resource-detail/GalgameSummaryCard'
import type { ReactElement } from 'react'

vi.mock('@bprogress/next/app', () => ({ useRouter: () => ({ push: vi.fn() }) }))

// HeroUI img slot 基础类为 opacity-0, 靠 data-loaded 显现, 而 use-image 在水合前
// status 恒为 pending: 内容图必须在 className 里显式给出不透明度, 经 twMerge 顶掉
// opacity-0, SSR HTML 才能直接可见, 否则 LCP 被水合完成时刻卡住
const imgClassTokens = (html: string, alt: string) => {
  const img = html
    .match(/<img\b[^>]*>/g)
    ?.find((tag) => tag.includes(`alt="${alt}"`))
  expect(img, `未找到 alt="${alt}" 的 img`).toBeDefined()
  return img!.match(/class="([^"]*)"/)![1].split(/\s+/)
}

const banner = 'https://example.com/patch/1/banner/banner.avif'

const galgame: GalgameCard = {
  id: 1,
  uniqueId: 'abcd1234',
  name: 'kun-galgame',
  banner,
  view: 1,
  download: 1,
  type: ['pc'],
  language: ['zh-Hans'],
  platform: ['windows'],
  created: '2026-01-01T00:00:00.000Z',
  _count: { favorite_folder: 0, resource: 0, comment: 0 }
}

const cases: [string, ReactElement, string, string][] = [
  [
    'GalgameCard',
    createElement(GalgameCard, { patch: galgame }),
    galgame.name,
    'opacity-100'
  ],
  [
    'KunAboutCard',
    createElement(KunAboutCard, {
      post: {
        title: 'kun-doc',
        banner,
        date: '2026-01-01',
        description: '',
        textCount: 1,
        slug: 'notice/kun-doc',
        path: 'notice/kun-doc'
      }
    }),
    'kun-doc',
    'opacity-95'
  ],
  [
    'BlogHeader',
    createElement(BlogHeader, {
      frontmatter: {
        title: 'kun-blog',
        banner,
        description: '',
        date: '2026-01-01',
        authorUid: 1,
        authorName: 'kun',
        authorAvatar: 'https://example.com/avatar.avif',
        authorHomepage: '',
        pin: false
      }
    }),
    'kun-blog',
    'opacity-100'
  ],
  [
    'UserGalgameCard',
    createElement(UserGalgameCard, {
      galgame,
      folderId: 1,
      pageUid: 1,
      currentUserUid: 2,
      onRemoveFavorite: () => {}
    }),
    galgame.name,
    'opacity-90'
  ],
  [
    'UserResourceCard',
    createElement(UserResourceCard, {
      resource: {
        id: 1,
        section: 'galgame',
        patchUniqueId: 'abcd1234',
        patchId: 1,
        patchName: 'kun-resource',
        patchBanner: banner,
        type: [],
        language: [],
        platform: [],
        emulatorType: [],
        modelName: '',
        created: '2026-01-01T00:00:00.000Z'
      }
    }),
    'kun-resource',
    'opacity-100'
  ],
  [
    'GalgameSummaryCard',
    createElement(GalgameSummaryCard, { galgame }),
    galgame.name,
    'opacity-100'
  ]
]

describe('内容图 SSR 即可见, 不依赖水合', () => {
  it.each(cases)('%s', (_, element, alt, opacity) => {
    const tokens = imgClassTokens(renderToString(element), alt)
    expect(tokens).toContain(opacity)
    expect(tokens).not.toContain('opacity-0')
  })
})
