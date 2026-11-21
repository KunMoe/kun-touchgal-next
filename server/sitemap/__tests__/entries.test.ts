import { describe, expect, it } from 'vitest'
import { resolveRouteData } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { KUN_ROUTE_POLICY, kunListedStaticRoutes } from '~/config/routePolicy'
import { buildKunSitemap } from '~/server/sitemap/entries'
import type { KunRoute } from '~/config/routePolicy'
import type { KunSitemapSource } from '~/server/sitemap/entries'

const origin = kunMoyuMoe.domain.main
const EMPTY: KunSitemapSource = { patches: [], companyIds: [], posts: [] }

// 静态部分排在前面, 只看某个展开函数的产出时把它切掉
const dynamicPart = (source: Partial<KunSitemapSource>) =>
  buildKunSitemap({ ...EMPTY, ...source }).slice(kunListedStaticRoutes().length)

describe('buildKunSitemap', () => {
  it('静态部分逐条对应不带参数的 listed 路由, 首页是不带斜杠的源站, 都不带 lastModified', () => {
    expect(buildKunSitemap(EMPTY)).toStrictEqual(
      kunListedStaticRoutes().map((route) => ({
        url: route === '/' ? origin : `${origin}${route}`
      }))
    )
  })

  it('静态部分的每个地址在登记表里都是 listed', () => {
    const paths = buildKunSitemap(EMPTY).map(
      (entry) => new URL(entry.url).pathname
    )

    expect(paths).toContain('/')
    for (const path of paths) {
      expect(KUN_ROUTE_POLICY[path as KunRoute], path).toBe('listed')
    }
  })

  it('作品按 unique_id 展开, lastModified 取资源更新时间', () => {
    const resourceUpdateTime = new Date('2026-11-20T08:00:00Z')

    expect(
      dynamicPart({ patches: [{ uniqueId: 'abCD1234', resourceUpdateTime }] })
    ).toStrictEqual([
      { url: `${origin}/abCD1234`, lastModified: resourceUpdateTime }
    ])
  })

  it('会社按 id 展开, 不带 lastModified', () => {
    expect(dynamicPart({ companyIds: [42, 7] })).toStrictEqual([
      { url: `${origin}/company/42` },
      { url: `${origin}/company/7` }
    ])
  })

  it('文档按 slug 展开, 有日期才带 lastModified', () => {
    expect(
      dynamicPart({
        posts: [
          { slug: 'post/202511dona', date: '2025-11-01T00:00:00.000Z' },
          { slug: 'notice/about', date: '' }
        ]
      })
    ).toStrictEqual([
      {
        url: `${origin}/doc/post/202511dona`,
        lastModified: '2025-11-01T00:00:00.000Z'
      },
      { url: `${origin}/doc/notice/about` }
    ])
  })

  it('每个地址里的 & < > " \' 都转成实体, 且只转一次', () => {
    expect(
      dynamicPart({
        patches: [
          { uniqueId: "a&'b", resourceUpdateTime: new Date('2026-01-01') }
        ],
        posts: [{ slug: `x&y<z>"q'`, date: '' }]
      }).map((entry) => entry.url)
    ).toStrictEqual([
      `${origin}/a&amp;&apos;b`,
      `${origin}/doc/x&amp;y&lt;z&gt;&quot;q&apos;`
    ])
  })

  it('经 Next 自己的序列化器输出后, <loc> 里的实体恰好转义一次', () => {
    const xml = resolveRouteData(
      buildKunSitemap({ ...EMPTY, posts: [{ slug: 'a&b<c>', date: '' }] }),
      'sitemap'
    )

    expect(xml).toContain(`<loc>${origin}/doc/a&amp;b&lt;c&gt;</loc>`)
    expect(xml).not.toContain('&amp;amp;')
  })
})
