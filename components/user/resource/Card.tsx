'use client'

import { useState } from 'react'
import { Chip } from '@heroui/chip'
import { Card, CardBody } from '@heroui/card'
import { Image } from '@heroui/image'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import Link from 'next/link'
import { KunPatchAttribute } from '~/components/kun/PatchAttribute'

import type { UserResource as UserResourceType } from '~/types/api/user'

interface Props {
  resource: UserResourceType
}

export const UserResourceCard = ({ resource }: Props) => {
  const [bannerFailed, setBannerFailed] = useState(false)
  const bannerImageSrc =
    resource.patchBanner && !bannerFailed
      ? resource.patchBanner.replace(/\.avif$/, '-mini.avif')
      : '/touchgal.avif'

  return (
    <Card
      isPressable
      as={Link}
      href={`/${resource.patchUniqueId}?tab=resources&resourceSection=${resource.section}&resourceId=${resource.id}`}
      prefetch={false}
      className="w-full"
    >
      <CardBody className="p-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="relative w-full sm:h-auto sm:w-40">
            {/* opacity-100 经 twMerge 顶掉 HeroUI img slot 的 opacity-0, 否则 SSR 封面要等水合才可见 */}
            <Image
              src={bannerImageSrc}
              alt={resource.patchName}
              className="object-cover rounded-lg size-full max-h-52 opacity-100"
              radius="lg"
              onError={() => setBannerFailed(true)}
            />
          </div>
          <div className="flex-1 space-y-3">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <h2 className="text-lg font-semibold transition-colors line-clamp-2 hover:text-primary-500">
                {resource.patchName}
              </h2>
              <Chip variant="flat">
                <KunTimeAgo date={resource.created} />
              </Chip>
            </div>

            <KunPatchAttribute
              types={resource.type}
              languages={resource.language}
              platforms={resource.platform}
              emulatorType={resource.emulatorType}
              modelName={resource.modelName}
              size="sm"
            />
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
