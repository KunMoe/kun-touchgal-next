'use client'

import { useState } from 'react'
import { useRouter } from '@bprogress/next/app'
import { Button } from '@heroui/button'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { kunFetchDelete } from '~/utils/kunFetch'

interface Props {
  conversationId: number
  otherUserName: string
}

export const DeleteConversationButton = ({
  conversationId,
  otherUserName
}: Props) => {
  const router = useRouter()
  const { isOpen, onOpen, onClose, onOpenChange } = useDisclosure()
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDeleteConversation = async () => {
    setIsDeleting(true)

    const response = await kunFetchDelete<KunResponse<{}>>(
      `/message/conversation/${conversationId}`,
      { action: 'conversation' }
    )

    if (typeof response === 'string') {
      toast.error(response)
      setIsDeleting(false)
      return
    }

    toast.success('私聊已删除')
    onClose()
    router.push('/message/chat')
    setIsDeleting(false)
  }

  return (
    <>
      <Button
        variant="light"
        color="danger"
        size="sm"
        isIconOnly
        aria-label="删除该私聊"
        onPress={onOpen}
      >
        <Trash2 className="size-4" />
      </Button>

      <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center">
        <ModalContent>
          <ModalHeader>删除私聊</ModalHeader>
          <ModalBody>
            <p>确定要删除与 {otherUserName} 的私聊吗？</p>
            <p className="text-sm text-danger">
              删除后会同步清空该会话中的全部消息，且不可撤销。
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose} isDisabled={isDeleting}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteConversation}
              isLoading={isDeleting}
              isDisabled={isDeleting}
            >
              删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
