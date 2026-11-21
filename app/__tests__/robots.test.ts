import { describe, expect, it } from 'vitest'
import { resolveRouteData } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data'
import robots from '~/app/robots'

describe('app/robots', () => {
  // 经 Next 自己的序列化得到爬虫实际读到的文本
  it('只有一个 * 分组, 禁抓前缀来自路由策略表, 并指向站点地图', () => {
    expect(resolveRouteData(robots(), 'robots')).toBe(
      [
        'User-Agent: *',
        'Disallow: /admin',
        'Disallow: /message',
        'Disallow: /tag',
        'Disallow: /user',
        'Disallow: /*?page=',
        'Disallow: /*&page=',
        '',
        'Sitemap: https://www.touchgal.ink/sitemap.xml',
        ''
      ].join('\n')
    )
  })
})
