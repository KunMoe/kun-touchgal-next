import { kunGetSitemap } from '~/server/sitemap/load'

// 站点地图要查库: 不声明的话 next build 会把它预渲染成静态文件, 构建时连生产库,
// 内容也冻结在构建那一刻。数据的复用交给 kunGetSitemap 的进程内记忆
export const dynamic = 'force-dynamic'

export default function sitemap() {
  return kunGetSitemap()
}
