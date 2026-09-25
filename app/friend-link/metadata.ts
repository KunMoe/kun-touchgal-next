import { kunMoyuMoe } from '~/config/moyu-moe'
import { kunFriends } from '~/config/friend'
import type { Metadata } from 'next'

const friendName = kunFriends.map((f) => f.name)

export const kunMetadata: Metadata = {
  title: '友情链接',
  description: `点击以进入 ${friendName}`,
  openGraph: {
    title: '友情链接',
    description: `点击以进入 ${friendName}`,
    type: 'website',
    images: kunMoyuMoe.images
  },
  twitter: {
    card: 'summary_large_image',
    title: '友情链接',
    description: `点击以进入 ${friendName}`,
    images: kunMoyuMoe.images
  },
  alternates: {
    canonical: `${kunMoyuMoe.domain.main}/friend-link`
  }
}
