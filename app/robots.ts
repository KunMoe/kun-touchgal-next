import { kunMoyuMoe } from '~/config/moyu-moe'
import { kunRobotsDisallow } from '~/config/routePolicy'
import type { MetadataRoute } from 'next'

// 只有一个 * 分组: 爬虫一旦有了点名自己的分组就只读那一组, * 组里的禁抓对它不再生效
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: kunRobotsDisallow() },
    sitemap: `${kunMoyuMoe.domain.main}/sitemap.xml`
  }
}
