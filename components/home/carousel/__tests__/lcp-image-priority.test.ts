import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KunDesktopCard } from '~/components/home/carousel/DesktopCard'
import { KunMobileCard } from '~/components/home/carousel/MobileCard'
import type { HomeCarouselMetadata } from '~/components/home/carousel/mdx'

// 首页 LCP 就是首张轮播 banner。next/image 的 preload 只输出 <link rel="preload">,
// 不会自动带 fetchpriority, 必须显式传 fetchPriority="high" 才能让 img 与 preload
// 一起提权; 非首张只在客户端轮换后渲染, 保持默认懒加载
const posts: HomeCarouselMetadata[] = [0, 1].map((i) => ({
  title: `post-${i}`,
  banner: `https://example.com/banner-${i}.avif`,
  description: '',
  date: '2026-01-01T00:00:00.000Z',
  authorName: 'kun',
  authorAvatar: 'https://example.com/avatar.avif',
  pin: true,
  directory: 'notice',
  link: '/doc/notice/kun'
}))

const bannerImg = (html: string, banner: string) => {
  const img = html
    .match(/<img\b[^>]*>/g)
    ?.find((tag) => tag.includes(`src="${banner}"`))
  expect(img, `未找到 src="${banner}" 的 img`).toBeDefined()
  return img!
}

describe.each([
  ['KunMobileCard', KunMobileCard],
  ['KunDesktopCard', KunDesktopCard]
])('%s LCP 图优先级', (_, Card) => {
  it('首张 banner 带 fetchPriority="high" 且不懒加载', () => {
    const html = renderToString(createElement(Card, { posts, currentSlide: 0 }))
    const img = bannerImg(html, posts[0].banner)
    expect(img).toContain('fetchPriority="high"')
    expect(img).not.toContain('loading=')
  })

  it('非首张 banner 保持懒加载且不提权', () => {
    const html = renderToString(createElement(Card, { posts, currentSlide: 1 }))
    const img = bannerImg(html, posts[1].banner)
    expect(img).toContain('loading="lazy"')
    expect(img).not.toContain('fetchPriority')
  })
})
