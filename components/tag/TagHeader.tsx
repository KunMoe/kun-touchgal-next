'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Button } from '@heroui/button'
import { useDisclosure } from '@heroui/modal'
import { Plus } from 'lucide-react'
import { KunHeader } from '../kun/Header'
import { LazyDialogFallback } from '~/components/patch/header/LazyDialogFallback'
import { useUserStore } from '~/store/userStore'
import type { Tag as TagType } from '~/types/api/tag'

// 表单连带 RHF, 只有管理员用得到, 静态导入会进每位访客的首屏.
// 首次打开后保持挂载, 保留关闭动画
const CreateTagModal = dynamic(
  () => import('~/components/tag/CreateTagModal').then((m) => m.CreateTagModal),
  { ssr: false, loading: () => <LazyDialogFallback hint="正在加载表单..." /> }
)

const preloadCreateTagModal = () => {
  void import('~/components/tag/CreateTagModal')
}

interface Props {
  setNewTag: (tag: TagType) => void
}

export const TagHeader = ({ setNewTag }: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const user = useUserStore((state) => state.user)
  const [hasOpened, setHasOpened] = useState(false)

  return (
    <>
      <KunHeader
        name="标签列表"
        description="这里是本站 Galgame 中的所有标签"
        headerEndContent={
          <>
            {user.role > 2 && (
              <Button
                color="primary"
                onPress={() => {
                  setHasOpened(true)
                  onOpen()
                }}
                onPointerEnter={preloadCreateTagModal}
                onFocus={preloadCreateTagModal}
                startContent={<Plus />}
              >
                创建标签
              </Button>
            )}
          </>
        }
      />

      {hasOpened && (
        <CreateTagModal
          isOpen={isOpen}
          onClose={onClose}
          onSuccess={(newTag) => {
            setNewTag(newTag)
            onClose()
          }}
        />
      )}
    </>
  )
}
