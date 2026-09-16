import { kunMoyuMoe } from '~/config/moyu-moe'
import type { Metadata } from 'next'

export const kunMetadata: Metadata = {
  title: '关注消息',
  description: `这是关注消息页面, 本页面展示了 ${kunMoyuMoe.titleShort} 用户关注的人最新的动态, 最近发布的 Galgame 资源, 发布的 Galgame 等等`,
  openGraph: {
    title: '关注消息',
    description: `这是关注消息页面, 本页面展示了 ${kunMoyuMoe.titleShort} 用户关注的人最新的动态, 最近发布的 Galgame 资源, 发布的 Galgame 等等`,
    type: 'website',
    images: kunMoyuMoe.images
  },
  twitter: {
    card: 'summary_large_image',
    title: '关注消息',
    description: `这是关注消息页面, 本页面展示了 ${kunMoyuMoe.titleShort} 用户关注的人最新的动态, 最近发布的 Galgame 资源, 发布的 Galgame 等等`
  },
  alternates: {
    canonical: `${kunMoyuMoe.domain.main}/message/follow`
  }
}
