'use client'

import { Chip } from '@heroui/chip'
import { Link } from '@heroui/link'
import { Cloud, Database, Link as LinkIcon } from 'lucide-react'
import { SUPPORTED_RESOURCE_LINK_MAP } from '~/constants/resource'
import type { JSX } from 'react'
import type { KunMoyuPatchResource } from '~/types/api/kun/moyu-moe'

const storageIcons: { [key: string]: JSX.Element } = {
  s3: <Cloud className="size-3" />,
  user: <LinkIcon className="size-3" />
}

interface Props {
  resource: KunMoyuPatchResource
}

export const KunResourceDownloadCard = ({ resource }: Props) => {
  return (
    <div className="flex flex-col space-y-2">
      <div className="flex items-center gap-2">
        <Chip
          color="secondary"
          variant="flat"
          size="sm"
          startContent={storageIcons[resource.storage]}
        >
          {SUPPORTED_RESOURCE_LINK_MAP[resource.storage]}
        </Chip>
        <Chip
          variant="flat"
          size="sm"
          startContent={<Database className="size-3" />}
        >
          {resource.size}
        </Chip>
      </div>

      <p className="text-sm text-default-500">
        点击前往下面的页面以下载游戏补丁
      </p>

      <Link
        isExternal
        underline="always"
        className="block break-all"
        href={resource.web_url}
      >
        {resource.web_url}
      </Link>
    </div>
  )
}
