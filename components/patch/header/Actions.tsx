'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Button } from '@heroui/button'
import { Download, Pencil, Share2, Trash2 } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'
import { usePathname, useSearchParams } from 'next/navigation'
import { useUserStore } from '~/store/userStore'
import { kunCopy } from '~/utils/kunCopy'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { FavoriteButton } from './button/favorite/FavoriteButton'
import { RatingButton } from './button/rating/RatingButton'
import { FeedbackButton } from './button/FeedbackButton'
import type { Patch } from '~/types/api/patch'

const DeletePatchDialog = dynamic(() => import('./DeletePatchDialog'), {
  ssr: false,
  loading: () => null
})

interface PatchHeaderActionsProps {
  patch: Patch
}

export const PatchHeaderActions = ({ patch }: PatchHeaderActionsProps) => {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const user = useUserStore((state) => state.user)

  const [isDeleteOpen, setIsDeleteOpen] = useState(false)

  const handleClickDownloadNav = () => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', 'resources')
    params.delete('commentId')
    params.delete('ratingId')
    const query = params.toString()
    window.history.pushState(
      null,
      '',
      query ? `${pathname}?${query}` : pathname
    )
  }

  const handleShareLink = () => {
    const text = `${patch.name} - ${kunMoyuMoe.domain.main}/${patch.uniqueId}`
    kunCopy(text)
  }

  return (
    <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
      <div className="flex flex-wrap gap-2">
        <Button
          color="primary"
          variant="shadow"
          startContent={<Download className="size-4" />}
          onPress={handleClickDownloadNav}
          size="sm"
          title="下载游戏"
        >
          下载
        </Button>

        <RatingButton patchId={patch.id} />

        <FavoriteButton patchId={patch.id} isFavorite={patch.isFavorite} />

        <Button
          variant="bordered"
          isIconOnly
          size="sm"
          onPress={handleShareLink}
          aria-label="复制分享链接"
          title="复制分享链接"
        >
          <Share2 className="size-4" />
        </Button>

        {user.role > 2 ? (
          <>
            <Button
              variant="bordered"
              isIconOnly
              size="sm"
              onPress={() => router.push('/edit/rewrite')}
              aria-label="编辑游戏信息"
              title="编辑游戏信息"
            >
              <Pencil className="size-4" />
            </Button>

            {user.role > 3 && (
              <Button
                variant="bordered"
                isIconOnly
                size="sm"
                onPress={() => setIsDeleteOpen(true)}
                aria-label="删除游戏"
                title="删除游戏"
              >
                <Trash2 className="size-4" />
              </Button>
            )}

            <FeedbackButton patch={patch} />
          </>
        ) : (
          <FeedbackButton patch={patch} />
        )}
      </div>

      <p className="text-xs text-default-500">
        收藏后, 有新资源发布时, 您将收到通知
      </p>

      {isDeleteOpen && (
        <DeletePatchDialog
          patchId={patch.id}
          isOpen={isDeleteOpen}
          onClose={() => setIsDeleteOpen(false)}
        />
      )}
    </div>
  )
}
