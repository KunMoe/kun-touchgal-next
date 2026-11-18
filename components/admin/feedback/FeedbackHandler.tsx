'use client'

import { useState } from 'react'
import { Button } from '@heroui/button'
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger
} from '@heroui/dropdown'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { Textarea } from '@heroui/input'
import { MoreVertical } from 'lucide-react'
import { kunFetchPost } from '~/utils/kunFetch'
import { errorReporter } from '~/utils/kunErrorHandler'
import type { AdminFeedback } from '~/types/api/admin'
import toast from 'react-hot-toast'

interface Props {
  initialFeedback: AdminFeedback
  onHandled?: (feedbackId: number) => void
}

export const FeedbackHandler = ({ initialFeedback, onHandled }: Props) => {
  const {
    isOpen: isOpenHandle,
    onOpen: onOpenHandle,
    onClose: onCloseHandle
  } = useDisclosure()
  const [handleContent, setHandleContent] = useState('')
  const [updating, setUpdating] = useState(false)
  const handleUpdateFeedback = async () => {
    setUpdating(true)
    try {
      const res = await kunFetchPost<KunResponse<AdminFeedback>>(
        '/admin/feedback/handle',
        {
          messageId: initialFeedback.id,
          content: handleContent.trim()
        }
      )
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        onCloseHandle()
        setHandleContent('')
        toast.success('处理反馈成功!')
        onHandled?.(initialFeedback.id)
      }
    } catch (error) {
      errorReporter(error)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <>
      <Dropdown>
        <DropdownTrigger>
          <Button
            isIconOnly
            aria-label="反馈操作菜单"
            size="sm"
            variant="light"
          >
            <MoreVertical size={16} />
          </Button>
        </DropdownTrigger>
        <DropdownMenu disabledKeys={initialFeedback.status ? ['handle'] : []}>
          <DropdownItem key="handle" onPress={onOpenHandle}>
            处理该反馈
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>

      <Modal isOpen={isOpenHandle} onClose={onCloseHandle} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">处理反馈</ModalHeader>
          <ModalBody>
            <Textarea
              value={handleContent}
              label="反馈回复内容 (可选)"
              onChange={(e) => setHandleContent(e.target.value)}
              placeholder="点击确定会通知用户该反馈已被处理"
              minRows={2}
              maxRows={8}
            />
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              onPress={() => {
                setHandleContent('')
                onCloseHandle()
              }}
            >
              取消
            </Button>
            <Button
              color="primary"
              onPress={handleUpdateFeedback}
              disabled={updating}
              isLoading={updating}
            >
              标记为已处理
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
