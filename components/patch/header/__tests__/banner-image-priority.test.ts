import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BannerImage } from '~/components/patch/header/BannerImage'

// /[id] 的 LCP 恒为头部横幅。布局提权只以 RFC 7540 PRIORITY 帧告知 CDN,
// 请求头 priority 仍是与 lazy 截图同级的 u=3,i; 只有显式 fetchPriority="high"
// 才能让最先发出的 preload 请求一开始就带 u=1
const banner = 'https://example.com/patch/1/banner/banner.avif'

const render = () =>
  renderToString(createElement(BannerImage, { banner, name: 'kun' }))

const findTag = (html: string, pattern: RegExp) => {
  const tag = html.match(pattern)?.[0]
  expect(tag, `未找到匹配 ${pattern} 的标签`).toBeDefined()
  return tag!
}

describe('BannerImage LCP 图优先级', () => {
  it('横幅 img 带 fetchPriority="high" 且不懒加载', () => {
    const img = findTag(render(), /<img\b[^>]*>/)
    expect(img).toContain(`src="${banner}"`)
    expect(img).toContain('fetchPriority="high"')
    expect(img).not.toContain('loading=')
  })

  it('横幅 preload 链接带 fetchPriority="high"', () => {
    const link = findTag(render(), /<link\b[^>]*rel="preload"[^>]*>/)
    expect(link).toContain(`href="${banner}"`)
    expect(link).toContain('fetchPriority="high"')
  })
})
