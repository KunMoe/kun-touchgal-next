import { kunMoyuMoe } from '~/config/moyu-moe'
import type { Metadata } from 'next'

export const kunMetadata: Metadata = {
  title: `注册 - ${kunMoyuMoe.titleShort}`,
  description: `注册成为 ${kunMoyuMoe.titleShort} 网站用户, 无门槛下载任何 Galgame 资源。希望明天对您来说又是美好的一天！`,
  keywords: [
    '注册',
    'Galgame 网站注册',
    '创建账户',
    'Galgame 资源下载',
    '免费注册'
  ],
  openGraph: {
    title: `注册 - ${kunMoyuMoe.titleShort}`,
    description: `注册成为 ${kunMoyuMoe.titleShort} 网站用户, 无门槛下载任何 Galgame 资源。希望明天对您来说又是美好的一天！`,
    url: `${kunMoyuMoe.domain.main}/register`,
    siteName: kunMoyuMoe.title,
    images: [
      {
        url: kunMoyuMoe.og.image,
        width: 1920,
        height: 1080,
        alt: `${kunMoyuMoe.titleShort} 注册页面`
      }
    ],
    locale: 'zh_CN',
    type: 'website'
  },
  alternates: {
    canonical: `${kunMoyuMoe.domain.main}/register`,
    languages: {
      'zh-Hans': `${kunMoyuMoe.domain.main}/register`
    }
  }
}
