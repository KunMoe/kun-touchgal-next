'use client'

import { Chip } from '@heroui/react'
import { Image } from '@heroui/image'
import Link from 'next/link'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import { bannerVariantUrl } from '~/utils/imageVariant'
import type { AdminGalgame } from '~/types/api/admin'

export const RenderCell = (galgame: AdminGalgame, columnKey: string) => {
  switch (columnKey) {
    case 'banner':
      return (
        <Image
          alt={galgame.name}
          className="object-cover"
          width={128}
          src={
            galgame.banner
              ? bannerVariantUrl(galgame.banner, 'mini')
              : '/touchgal.avif'
          }
          style={{ aspectRatio: '16/9' }}
        />
      )
    case 'name':
      return (
        <Link
          href={`/${galgame.uniqueId}`}
          className="font-medium hover:text-primary-500"
        >
          {galgame.name}
        </Link>
      )
    case 'user':
      return (
        <KunUser
          user={galgame.user}
          userProps={{
            name: galgame.user.name,
            avatarProps: {
              src: galgame.user.avatar
            }
          }}
        />
      )
    case 'created':
      return (
        <Chip size="sm" variant="light">
          <KunTimeAgo date={galgame.created} />
        </Chip>
      )
    default:
      return null
  }
}
