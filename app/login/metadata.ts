import { kunMoyuMoe } from '~/config/moyu-moe'
import type { Metadata } from 'next'

export const kunMetadata: Metadata = {
  title: `登录 - ${kunMoyuMoe.titleShort}`,
  description: `登录 ${kunMoyuMoe.titleShort} 网站, 随心所欲的收藏, 点赞, 下载任何 Galgame 资源。欢迎您回家! 辛苦了!`,
  keywords: [
    '登录',
    'Galgame 网站登录',
    '登录账户',
    'Galgame 资源下载',
    '用户认证'
  ],
  openGraph: {
    title: `登录 - ${kunMoyuMoe.titleShort}`,
    description: `登录 ${kunMoyuMoe.titleShort} 网站, 随心所欲的收藏, 点赞, 下载任何 Galgame 资源。欢迎您回家! 辛苦了!`,
    url: `${kunMoyuMoe.domain.main}/login`,
    siteName: kunMoyuMoe.title,
    images: [
      {
        url: kunMoyuMoe.og.image,
        width: 1920,
        height: 1080,
        alt: `登录 - ${kunMoyuMoe.titleShort}`
      }
    ],
    locale: 'zh_CN',
    type: 'website'
  },
  alternates: {
    canonical: `${kunMoyuMoe.domain.main}/login`,
    languages: {
      'zh-Hans': `${kunMoyuMoe.domain.main}/login`
    }
  }
}
