import { kunMoyuMoe } from '~/config/moyu-moe'
import type { Metadata } from 'next'

export const kunMetadata: Metadata = {
  title: '申请已经提交 | 审核中',
  description: `感谢您申请成为创作者! 我们会在数小时内审核您的请求! 创作者请求正在审核中`,
  openGraph: {
    title: '申请已经提交 | 审核中',
    description: `感谢您申请成为创作者! 我们会在数小时内审核您的请求! 创作者请求正在审核中`,
    type: 'website',
    images: kunMoyuMoe.images
  },
  twitter: {
    card: 'summary_large_image',
    title: '申请已经提交 | 审核中',
    description: `感谢您申请成为创作者! 我们会在数小时内审核您的请求! 创作者请求正在审核中`
  },
  robots: {
    index: false
  },
  alternates: {
    canonical: `${kunMoyuMoe.domain.main}/apply`
  }
}
