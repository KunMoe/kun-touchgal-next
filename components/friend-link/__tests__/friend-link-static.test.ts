import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { kunMetadata } from '~/app/friend-link/metadata'
import { kunFriends } from '~/config/friend'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { KunFriendLink } from '../KunFriendLink'

// C32: 友链页是构建期静态列表, 必须保持零客户端 JS 的 Server Component。
// 曾经整页 'use client' + framer initial 把全部内容以 opacity:0 输出 (移动节流 LCP 5.6s),
// 卡片用 onPress + window.open 打开, SSR 里没有可抓取的 <a href> 且不隐含 noopener
const source = readFileSync(
  fileURLToPath(new URL('../KunFriendLink.tsx', import.meta.url)),
  'utf-8'
)
const html = renderToStaticMarkup(createElement(KunFriendLink))
const anchors = html.match(/<a [^>]*>/g) ?? []

const escapeAttr = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

const findAnchor = (href: string) =>
  anchors.find((tag) => tag.includes(`href="${escapeAttr(href)}"`))

describe('KunFriendLink 静态渲染', () => {
  it('不是客户端组件, 不引入 framer / HeroUI 组件 / window.open', () => {
    expect(source).not.toMatch(/['"]use client['"]/)
    expect(source).not.toMatch(/framer-motion|@heroui\/|window\.open/)
  })

  it('SSR 内容直接可见, 没有 opacity:0 门控', () => {
    expect(html).not.toMatch(/opacity:\s*0/)
    expect(html).not.toContain('<button')
  })

  // 有宽高的原生 img 加载失败时即使 alt="" 也会显示破图图标, 头像用背景图只剩空白
  it('头像不用 img, 也就不会被 React 生成 preload', () => {
    expect(html).not.toContain('<img')
  })

  // 只写 noopener 不写 noreferrer: 保留 Referer 让友站能看到来自本站的流量
  it.each(kunFriends)('$name 渲染为新标签打开的可抓取链接', (friend) => {
    const anchor = findAnchor(friend.link)
    expect(anchor).toBeDefined()
    expect(anchor).toContain('target="_blank"')
    expect(anchor).toContain('rel="noopener"')
    expect(html).toContain(escapeAttr(friend.avatar))
  })

  it('Discord 链接保持 noopener noreferrer', () => {
    const anchor = findAnchor(kunMoyuMoe.domain.discord_group)
    expect(anchor).toBeDefined()
    expect(anchor).toContain('target="_blank"')
    expect(anchor).toContain('rel="noopener noreferrer"')
  })
})

describe('友链页 metadata', () => {
  it('openGraph images 使用站点图片而不是友站网页地址', () => {
    expect(kunMetadata.openGraph?.images).toEqual(kunMoyuMoe.images)
  })
})
