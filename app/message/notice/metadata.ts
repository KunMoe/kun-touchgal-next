import { kunMoyuMoe } from '~/config/moyu-moe'
import type { Metadata } from 'next'

export const kunMetadata: Metadata = {
  title: '通知消息',
  description: `这是通知消息页面, 本页面展示了 ${kunMoyuMoe.titleShort} 用户的被赞, 评论, 被回复, 被关注, 关注者, 私信 消息`,
  openGraph: {
    title: '通知消息',
    description: `这是通知消息页面, 本页面展示了 ${kunMoyuMoe.titleShort} 用户的被赞, 评论, 被回复, 被关注, 关注者, 私信 消息`,
    type: 'website',
    images: kunMoyuMoe.images
  },
  twitter: {
    card: 'summary_large_image',
    title: '通知消息',
    description: `这是通知消息页面, 本页面展示了 ${kunMoyuMoe.titleShort} 用户的被赞, 评论, 被回复, 被关注, 关注者, 私信 消息`
  },
  alternates: {
    canonical: `${kunMoyuMoe.domain.main}/message/notice`
  }
}
