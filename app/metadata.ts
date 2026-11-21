import { kunMoyuMoe } from '~/config/moyu-moe'
import { generateNullMetadata } from '~/utils/noIndex'
import { KUN_BASE_OPEN_GRAPH, KUN_BASE_TWITTER } from '~/utils/pageMetadata'
import type { Metadata, Viewport } from 'next'

export const kunViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' }
  ],
  colorScheme: 'light dark'
}

export const generateKunMetadata = (): Metadata => {
  if (process.env.KUN_VISUAL_NOVEL_TEST_SITE_LABEL) {
    return generateNullMetadata('测试站点')
  }

  return {
    metadataBase: new URL(kunMoyuMoe.domain.main),
    title: {
      default: kunMoyuMoe.title,
      template: kunMoyuMoe.template
    },
    description: kunMoyuMoe.description,
    keywords: kunMoyuMoe.keywords,
    authors: kunMoyuMoe.author,
    icons: {
      apple: '/apple-touch-icon.png',
      icon: '/favicon.ico'
    },
    creator: kunMoyuMoe.creator.name,
    publisher: kunMoyuMoe.publisher.name,
    formatDetection: {
      email: false,
      address: false,
      telephone: false
    },
    openGraph: {
      ...KUN_BASE_OPEN_GRAPH,
      title: kunMoyuMoe.title,
      description: kunMoyuMoe.description
    },
    twitter: {
      ...KUN_BASE_TWITTER,
      title: kunMoyuMoe.title,
      description: kunMoyuMoe.description
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1
      }
    },
    // './' 由 Next 按当前请求的 pathname 解析: 没有自己声明 alternates 的页面继承到的规范地址
    // 是它自己, 而不是首页 (openGraph.url 同理, 见 KUN_BASE_OPEN_GRAPH)
    alternates: {
      canonical: './',
      languages: {
        'zh-Hans': './'
      }
    }
  }
}
