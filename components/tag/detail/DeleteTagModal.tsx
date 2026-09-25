'use client'

import { useState } from 'react'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { Button } from '@heroui/button'
import { kunFetchDelete } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import toast from 'react-hot-toast'
import { useRouter } from '@bprogress/next/app'
import { useUserStore } from '~/store/userStore'
import { Trash2 } from 'lucide-react'
import type { Tag } from '~/types/api/tag'

interface Props {
  tag: Tag
}

export const DeleteTagModal = ({ tag }: Props) => {
  const router = useRouter()
  const user = useUserStore((state) => state.user)

  const { isOpen, onOpen, onClose } = useDisclosure()
  const [deleting, setDeleting] = useState(false)
  const handleDeleteTag = async () => {
    setDeleting(true)
    const res = await kunFetchDelete<KunResponse<{}>>('/tag', {
      tagId: tag.id
    })
    kunErrorHandler(res, () => {
      onClose()
      router.push('/tag')
      toast.success('标签删除成功')
    })
    setDeleting(false)
  }

  return (
    <>
      {user.role > 2 && (
        <Button
          variant="flat"
          color="danger"
          onPress={onOpen}
          startContent={<Trash2 />}
        >
          删除该标签
        </Button>
      )}

      <Modal isOpen={isOpen} onClose={onClose} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">删除标签</ModalHeader>
          <ModalBody>
            <p>
              您确定要删除这个标签吗, 这将会同步删除所有 Galgame 中含有的本标签,
              该操作不可撤销
            </p>
            <p className="pl-4 border-l-4 border-primary-500">{tag.name}</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteTag}
              disabled={deleting}
              isLoading={deleting}
            >
              删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
