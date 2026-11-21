import { kunMoyuMoe } from '~/config/moyu-moe'
import type { Metadata } from 'next'

// Next 对 openGraph / twitter 是整块替换, 不逐字段合并: 页面只要自己写了其中一块,
// 根布局给的 siteName、locale、url 就全没了。所以根布局与页面都从这两份基线展开。
// url 写成 './', 由 Next 按当前请求的 pathname 解析, 页面里不出现任何手写的地址
export const KUN_BASE_OPEN_GRAPH = {
  type: 'website',
  locale: 'zh_CN',
  siteName: kunMoyuMoe.title,
  images: kunMoyuMoe.images,
  url: './'
} satisfies Metadata['openGraph']

export const KUN_BASE_TWITTER = {
  card: 'summary_large_image',
  creator: kunMoyuMoe.creator.mention,
  images: kunMoyuMoe.images
} satisfies Metadata['twitter']

export interface KunPageMeta {
  // 只写页面名; 站点后缀由根布局的 title.template 补, 这里带上就会出现两次
  title: string
  // 只写一次, og 与 twitter 的描述由它派生; 不写则沿用站点描述
  description?: string
  keywords?: string[]
  // 只给已裁定的归一例外用 (流程结果页归到父级); 其余页面的规范地址就是它自己
  canonicalPath?: `/${string}`
  // 要与 config/routePolicy.ts 的登记一致, 由 app/__tests__/page-metadata.test.ts 核对
  noindex?: true
}

// 客户端改 document.title 时用, 与根布局的 title.template 出自同一个模板。
// 替换值用函数给出: 标题 (作品名、用户名) 里可能有 $& 这类会被 replace 当成占位符的字符。
// Next 自己套模板时是直接传字符串 (resolve-title.js), 含这类字符的标题在服务端输出里会被改写
export const kunDocumentTitle = (title: string) =>
  kunMoyuMoe.template.replace('%s', () => title)

// 不带路由参数的页面的 metadata。可索引的页面不输出 robots 字段:
// 测试站点靠根布局的 noindex 被页面继承, 页面一旦自己写了 robots 就把它盖掉了。
// 没有值的字段整个不出现 (Next 把值为 undefined 的键也当成「页面声明了它」, 会清掉继承来的值)
export const kunPageMetadata = (meta: KunPageMeta): Metadata => {
  const social = {
    title: kunDocumentTitle(meta.title),
    ...(meta.description ? { description: meta.description } : {})
  }

  return {
    title: meta.title,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.keywords ? { keywords: meta.keywords } : {}),
    openGraph: {
      ...KUN_BASE_OPEN_GRAPH,
      ...social,
      ...(meta.canonicalPath ? { url: meta.canonicalPath } : {})
    },
    twitter: { ...KUN_BASE_TWITTER, ...social },
    ...(meta.canonicalPath
      ? { alternates: { canonical: meta.canonicalPath } }
      : {}),
    ...(meta.noindex ? { robots: { index: false } } : {})
  }
}
