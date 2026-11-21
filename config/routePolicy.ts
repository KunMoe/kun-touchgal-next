// 一条路由对搜索引擎的公开契约只在这里登记一次, app/robots.ts 与站点地图都从这张表派生。
// listed   可抓取, 可索引, 提交进站点地图
// unlisted 可抓取, 可索引, 不提交
// noindex  可抓取, 页面自己声明 noindex, 不提交
// blocked  robots.txt 禁抓, 不提交
// 「禁抓却进了站点地图」「noindex 却进了站点地图」在这四个取值里写不出来
export type KunCrawlPolicy = 'listed' | 'unlisted' | 'noindex' | 'blocked'

// 键与 app 下的 page.tsx 一一对应, 新页面不登记过不了 config/__tests__/routePolicy.test.ts;
// 页面的 metadata 是否与登记一致由 app/__tests__/page-metadata.test.ts 核对, 页面本身不导入这张表。
// 登录闸门不归这里管: proxy.ts 的 matcher 只能写静态字面量, 单独维护
export const KUN_ROUTE_POLICY = {
  '/': 'listed',
  '/[id]': 'listed',
  '/apply': 'listed',
  '/auth/forgot': 'listed',
  '/company': 'listed',
  '/company/[id]': 'listed',
  '/doc': 'listed',
  '/doc/[...slug]': 'listed',
  '/friend-link': 'listed',
  '/galgame': 'listed',
  '/login': 'listed',
  '/register': 'listed',
  '/resource': 'listed',
  '/search': 'listed',

  '/[id]/resource/[resourceId]': 'unlisted',
  '/edit': 'unlisted',
  '/edit/create': 'unlisted',
  '/edit/rewrite': 'unlisted',
  '/edit/rewrite/[uniqueId]': 'unlisted',

  '/apply/pending': 'noindex',
  '/apply/success': 'noindex',
  '/auth/email-notice': 'noindex',
  '/auth/forgot/reset': 'noindex',
  '/login/2fa': 'noindex',
  '/oidc/interaction/[uid]': 'noindex',
  '/redirect': 'noindex',
  '/settings/user': 'noindex',

  '/admin': 'blocked',
  '/admin/appeal': 'blocked',
  '/admin/comment': 'blocked',
  '/admin/creator': 'blocked',
  '/admin/email': 'blocked',
  '/admin/feedback': 'blocked',
  '/admin/galgame': 'blocked',
  '/admin/log': 'blocked',
  '/admin/moderation': 'blocked',
  '/admin/oidc': 'blocked',
  '/admin/rating': 'blocked',
  '/admin/rating-report': 'blocked',
  '/admin/report': 'blocked',
  '/admin/resource': 'blocked',
  '/admin/resource-apply': 'blocked',
  '/admin/setting': 'blocked',
  '/admin/user': 'blocked',
  '/message': 'blocked',
  '/message/chat': 'blocked',
  '/message/chat/[conversationId]': 'blocked',
  '/message/follow': 'blocked',
  '/message/mention': 'blocked',
  '/message/notice': 'blocked',
  '/message/system': 'blocked',
  '/tag': 'blocked',
  '/tag/[id]': 'blocked',
  '/user': 'blocked',
  '/user/[id]': 'blocked',
  '/user/[id]/comment': 'blocked',
  '/user/[id]/favorite': 'blocked',
  '/user/[id]/rating': 'blocked',
  '/user/[id]/resource': 'blocked'
} as const satisfies Record<`/${string}`, KunCrawlPolicy>

export type KunRoute = keyof typeof KUN_ROUTE_POLICY

export type KunListedRoute = {
  [Route in KunRoute]: (typeof KUN_ROUTE_POLICY)[Route] extends 'listed'
    ? Route
    : never
}[KunRoute]

// 与路由无关的禁抓: 分页地址不单独抓取
export const KUN_ROBOTS_EXTRA_DISALLOW = ['/*?page=', '/*&page='] as const

const routes = Object.keys(KUN_ROUTE_POLICY) as KunRoute[]

const routesOf = (policy: KunCrawlPolicy) =>
  routes.filter((route) => KUN_ROUTE_POLICY[route] === policy)

// Disallow 按前缀匹配, 所以只输出最上层的 blocked 路由, 它下面的页面已经被盖住
export const kunRobotsDisallow = (): string[] => {
  const blocked = routesOf('blocked')
  return [
    ...blocked.filter(
      (route) => !blocked.some((parent) => route.startsWith(`${parent}/`))
    ),
    ...KUN_ROBOTS_EXTRA_DISALLOW
  ]
}

// 站点地图里不带路由参数的那一部分; 带参数的 listed 路由由 server/sitemap/entries.ts 逐条展开
export const kunListedStaticRoutes = (): KunListedRoute[] =>
  (routesOf('listed') as KunListedRoute[]).filter(
    (route) => !route.includes('[')
  )
