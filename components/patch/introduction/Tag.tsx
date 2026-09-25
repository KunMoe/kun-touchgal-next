'use client'

import { useState } from 'react'
import { Chip } from '@heroui/chip'
import { Link } from '@heroui/link'
import dynamic from 'next/dynamic'
import { useShallow } from 'zustand/react/shallow'
import { useUserStore } from '~/store/userStore'
import type { Tag } from '~/types/api/tag'

const PatchTagSelector = dynamic(
  () => import('./PatchTagSelector').then((mod) => mod.PatchTagSelector),
  { ssr: false }
)

interface Props {
  patchId: number
  initialTags: Tag[]
}

export const PatchTag = ({ patchId, initialTags }: Props) => {
  const [selectedTags, setSelectedTags] = useState<Tag[]>(initialTags ?? [])
  const blockedTagIds = useUserStore(
    useShallow((state) => state.user.blockedTagIds)
  )
  const canEditTags = useUserStore((state) => state.user.role > 2)
  const visibleTags = selectedTags.filter(
    (tag) => !blockedTagIds.includes(tag.id)
  )

  return (
    <div className="mt-4 space-y-4">
      <h2 className="pt-8 mt-12 text-2xl border-t border-default-200">
        游戏标签
      </h2>

      <div className="flex flex-wrap gap-2">
        {visibleTags.map((tag) => (
          <Link
            key={tag.id}
            href={`/tag/${tag.id}`}
            title={`${tag.count} 个 Galgame 使用此标签`}
          >
            <Chip color="secondary" variant="flat">
              {tag.name}
              {` +${tag.count}`}
            </Chip>
          </Link>
        ))}

        {!visibleTags.length && (
          <Chip>{'这个 Galgame 暂时没有可显示的标签'}</Chip>
        )}
      </div>

      {canEditTags && (
        <PatchTagSelector
          patchId={patchId}
          initialTags={selectedTags}
          onTagChange={setSelectedTags}
        />
      )}
    </div>
  )
}
