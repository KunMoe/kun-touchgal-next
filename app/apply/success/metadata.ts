import { kunMoyuMoe } from '~/config/moyu-moe'
import type { Metadata } from 'next'

export const kunMetadata: Metadata = {
  title: '恭喜成为创作者',
  description: `您的创作者申请已经通过, 现在可以使用本站存储发布 Galgame 资源了`,
  openGraph: {
    title: '恭喜成为创作者',
    description: `您的创作者申请已经通过, 现在可以使用本站存储发布 Galgame 资源了`,
    type: 'website',
    images: kunMoyuMoe.images
  },
  twitter: {
    card: 'summary_large_image',
    title: '恭喜成为创作者',
    description: `您的创作者申请已经通过, 现在可以使用本站存储发布 Galgame 资源了`
  },
  robots: {
    index: false
  },
  alternates: {
    canonical: `${kunMoyuMoe.domain.main}/apply`
  }
}
