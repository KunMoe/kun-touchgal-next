'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/react'
import { Trash2 } from 'lucide-react'
import { kunFetchDelete } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import { DELETED_USER_NAME } from '~/constants/user'
import type { AdminUser } from '~/types/api/admin'

interface Props {
  user: AdminUser
  onDeleted?: (uid: number) => void
}

export const UserDelete = ({ user, onDeleted }: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [deleting, setDeleting] = useState(false)
  const handleUpdateUserInfo = async () => {
    setDeleting(true)
    try {
      const res = await kunFetchDelete<KunResponse<{}>>('/admin/user', {
        uid: user.id
      })
      kunErrorHandler(res, () => {
        toast.success('永久删除用户成功')
        onDeleted?.(user.id)
      })
      onClose()
    } catch (error) {
      errorReporter(error)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Button
        isIconOnly
        aria-label="永久删除用户"
        size="sm"
        color="danger"
        variant="light"
        onPress={onOpen}
      >
        <Trash2 size={16} />
      </Button>

      <Modal size="2xl" isOpen={isOpen} onClose={onClose}>
        <ModalContent>
          <ModalHeader>删除用户: {user.name}</ModalHeader>
          <ModalBody>
            <div>
              <h2 className="text-2xl text-danger">严重警告</h2>
              <p>您确定要永久删除用户 {user.name} 吗?</p>
              <p>
                将删除该用户建档的全部 Galgame (连同其他人在这些 Galgame
                下的内容), 以及该用户的全部资源、评论与评价, 该操作不可撤销
              </p>
              <p>
                该用户创建的标签、会社、审核黑名单规则与管理日志会保留,
                创建者显示为「{DELETED_USER_NAME}」
              </p>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>
              取消
            </Button>
            <Button
              color="danger"
              isDisabled={deleting}
              isLoading={deleting}
              onPress={handleUpdateUserInfo}
            >
              永久删除用户
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
