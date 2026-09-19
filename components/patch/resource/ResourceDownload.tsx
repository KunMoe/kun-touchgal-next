'use client'

import { useState } from 'react'
import { Button } from '@heroui/react'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import { Download } from 'lucide-react'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { ResourceLikeButton } from './ResourceLike'
import { ResourceDownloadCard } from './DownloadCard'
import type { PatchResource } from '~/types/api/patch'

interface Props {
  resource: PatchResource
}

// 资源备注不在卡片上展示, 点击资源名进入资源详情页查看简介与评论
export const ResourceDownload = ({ resource }: Props) => {
  const isPending = resource.status === 2 || resource.status === 3
  const [showLinks, setShowLinks] = useState(false)

  return (
    <div className="space-y-3">
      <div className="flex justify-between">
        <KunUser
          user={resource.user}
          userProps={{
            name: resource.user.name,
            description: (
              <>
                发布于{' '}
                <KunTimeAgo date={resource.created} maxRelativeDays={7} />
              </>
            ),
            avatarProps: {
              showFallback: true,
              src: resource.user.avatar,
              name: resource.user.name.charAt(0).toUpperCase()
            }
          }}
        />

        <div className="flex gap-2">
          <ResourceLikeButton resource={resource} isDisabled={isPending} />
          <Button
            color="primary"
            isIconOnly
            aria-label={`下载 Galgame 资源`}
            isDisabled={isPending}
            onPress={() => setShowLinks((v) => !v)}
          >
            <Download className="size-4" />
          </Button>
        </div>
      </div>

      {showLinks && (
        <div className="space-y-3">
          {resource.links.map((link) => (
            <ResourceDownloadCard
              key={link.id}
              resource={resource}
              link={link}
            />
          ))}
        </div>
      )}
    </div>
  )
}
