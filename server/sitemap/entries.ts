import { kunMoyuMoe } from '~/config/moyu-moe'
import { kunListedStaticRoutes } from '~/config/routePolicy'
import type { MetadataRoute } from 'next'
import type { KunListedRoute } from '~/config/routePolicy'

export interface KunSitemapSource {
  patches: { uniqueId: string; resourceUpdateTime: Date }[]
  companyIds: number[]
  posts: { slug: string; date: string }[]
}

type KunSitemapExpander = (source: KunSitemapSource) => MetadataRoute.Sitemap

const origin = kunMoyuMoe.domain.main

// 路由表里每条带参数的 listed 路由在这里各有一个展开函数: 表里增删这类路由而这里没跟上,
// satisfies 报缺键或多余的键, 编译不过
const DYNAMIC_EXPANDERS = {
  '/[id]': (source) =>
    source.patches.map((patch) => ({
      url: `${origin}/${patch.uniqueId}`,
      lastModified: patch.resourceUpdateTime
    })),
  '/company/[id]': (source) =>
    source.companyIds.map((id) => ({ url: `${origin}/company/${id}` })),
  '/doc/[...slug]': (source) =>
    source.posts.map((post) => ({
      url: `${origin}/doc/${post.slug}`,
      ...(post.date ? { lastModified: post.date } : {})
    }))
} satisfies Record<
  Extract<KunListedRoute, `${string}[${string}`>,
  KunSitemapExpander
>

const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;'
}

// Next 把 url 原样拼进 <loc> (resolve-route-data.js 的 resolveSitemap), 不替我们转义
const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => XML_ENTITIES[char])

export const buildKunSitemap = (
  source: KunSitemapSource
): MetadataRoute.Sitemap =>
  [
    // 首页写成不带斜杠的源站: Next 为 '/' 解析出的 canonical 就是 origin (resolve-url.js)
    ...kunListedStaticRoutes().map((route) => ({
      url: route === '/' ? origin : `${origin}${route}`
    })),
    ...Object.values(DYNAMIC_EXPANDERS).flatMap(
      (expand): MetadataRoute.Sitemap => expand(source)
    )
  ].map((entry) => ({ ...entry, url: escapeXml(entry.url) }))
