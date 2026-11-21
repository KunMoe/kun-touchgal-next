import { kunMoyuMoe } from '~/config/moyu-moe'
import type { Metadata } from 'next'
import type { KunSiteImage } from '~/config/config'

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

// 社交卡片与页面本身不一样的部分
export interface KunPageSocial {
  // 不写就用页面的标题与描述; 标题同样不带站点后缀
  title?: string
  description?: string
  // 换掉站点的分享图
  images?: KunSiteImage[]
  // 详情页按文章输出: og:type 为 article, 并带上给出的时间与标签
  article?: { publishedTime?: string; modifiedTime?: string; tags?: string[] }
  // twitter 卡片的版式, 不写是大图
  card?: 'summary'
}

export interface KunPageMeta {
  // 只写页面名; 站点后缀由根布局的 title.template 补, 这里带上就会出现两次
  title: string
  // 只写一次, og 与 twitter 的描述由它派生。不写则沿用站点描述; 写成空串是「这个页面没有描述」
  // (简介为空的会社页), 不会回落到站点描述, 否则几千个页面带着同一句话
  description?: string
  keywords?: string[]
  // 规范地址不是请求的地址本身时才写: 流程结果页归到父级; 详情页按实体自己的标识给出
  // (/company/8.5 渲染的是 8 号会社, 规范地址要回到 /company/8)。其余页面的规范地址就是它自己
  canonicalPath?: `/${string}`
  // 要与 config/routePolicy.ts 的登记一致, 由 app/__tests__/page-metadata.test.ts 核对
  noindex?: true
  social?: KunPageSocial
}

// 客户端改 document.title 时用, 与根布局的 title.template 出自同一个模板。
// 替换值用函数给出: 标题 (作品名、用户名) 里可能有 $& 这类会被 replace 当成占位符的字符。
// Next 自己套模板时是直接传字符串 (resolve-title.js), 含这类字符的标题在服务端输出里会被改写
export const kunDocumentTitle = (title: string) =>
  kunMoyuMoe.template.replace('%s', () => title)

// 一个页面的 metadata。可索引的页面不输出 robots 字段:
// 测试站点靠根布局的 noindex 被页面继承, 页面一旦自己写了 robots 就把它盖掉了。
// 没有值的字段整个不出现 (Next 把值为 undefined 的键也当成「页面声明了它」, 会清掉继承来的值)
export const kunPageMetadata = (meta: KunPageMeta): Metadata => {
  const { social } = meta
  const description = social?.description ?? meta.description
  const card = {
    title: kunDocumentTitle(social?.title ?? meta.title),
    ...(description !== undefined ? { description } : {}),
    ...(social?.images ? { images: social.images } : {})
  }
  const openGraph = {
    ...KUN_BASE_OPEN_GRAPH,
    ...card,
    ...(meta.canonicalPath ? { url: meta.canonicalPath } : {})
  }

  return {
    title: meta.title,
    ...(meta.description !== undefined
      ? { description: meta.description }
      : {}),
    ...(meta.keywords ? { keywords: meta.keywords } : {}),
    openGraph: social?.article
      ? { ...openGraph, type: 'article', ...social.article }
      : openGraph,
    twitter: {
      ...KUN_BASE_TWITTER,
      ...card,
      ...(social?.card ? { card: social.card } : {})
    },
    ...(meta.canonicalPath
      ? { alternates: { canonical: meta.canonicalPath } }
      : {}),
    ...(meta.noindex ? { robots: { index: false } } : {})
  }
}
