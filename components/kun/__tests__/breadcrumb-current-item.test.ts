import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBreadcrumbItem,
  getBreadcrumbTitleKey
} from '~/constants/routes/routes'
import { KunNavigationBreadcrumb } from '../NavigationBreadcrumb'

// C56: 页面标题靠 KunBreadcrumbTitle 的 layout effect 注入, SSR 与 NSFW 屏蔽态 (标题为空) 下
// 游戏页塌缩成「主页 > Galgame」, 曾把 Galgame 标成 aria-current 且不可点;
// /doc 在 SSG 与 404 下曾把原始路径当成当前项文字
const navigation = vi.hoisted(() => ({
  pathname: '/',
  params: {} as Record<string, string | string[]>
}))

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useParams: () => navigation.params
}))

const renderAt = (
  pathname: string,
  params: Record<string, string | string[]>
) => {
  navigation.pathname = pathname
  navigation.params = params
  return renderToStaticMarkup(createElement(KunNavigationBreadcrumb))
}

describe('面包屑 SSR 只把当前页标成 aria-current', () => {
  beforeEach(() => {
    navigation.pathname = '/'
    navigation.params = {}
  })

  it('游戏页未注册标题时 Galgame 保持链接, 不标当前页', () => {
    const markup = renderAt('/0712bedd', { id: '0712bedd' })

    expect(markup).not.toContain('aria-current')
    expect(markup).toContain('href="/galgame"')
  })

  it('资源页未注册标题时同样不标当前页', () => {
    const markup = renderAt('/0712bedd/resource/5', {
      id: '0712bedd',
      resourceId: '5'
    })

    expect(markup).not.toContain('aria-current')
    expect(markup).toContain('href="/galgame"')
  })

  it('通用标签兜底的详情页仍标当前页', () => {
    const markup = renderAt('/company/825', { id: '825' })

    expect(markup).toMatch(/aria-current="page"[^>]*>会社详情</)
  })

  it('文档页兜底用通用标签, 不输出原始路径', () => {
    const markup = renderAt('/doc/post/x', { slug: ['post', 'x'] })

    expect(markup).toMatch(/aria-current="page"[^>]*>文档详情</)
    expect(markup).not.toContain('/doc/post/x')
  })
})

describe('注册标题后末项的 key 与 titleKey 一致', () => {
  it.each([
    ['/0712bedd', { id: '0712bedd' }],
    ['/0712bedd/resource/5', { id: '0712bedd', resourceId: '5' }],
    ['/tag/1', { id: '1' }],
    ['/company/825', { id: '825' }],
    ['/doc/post/x', { slug: ['post', 'x'] }],
    ['/user/1/comment', { id: '1' }],
    ['/message/chat/3', { conversationId: '3' }]
  ])('%s', (pathname, params) => {
    const items = createBreadcrumbItem(pathname, params, '标题', '游戏名')

    expect(items.at(-1)?.key).toBe(getBreadcrumbTitleKey(pathname, params))
  })
})
