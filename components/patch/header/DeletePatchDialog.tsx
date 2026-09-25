'use client'

import { useState } from 'react'
import { useRouter } from '@bprogress/next/app'
import { Button } from '@heroui/button'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/modal'
import toast from 'react-hot-toast'
import { kunFetchDelete } from '~/utils/kunFetch'

interface Props {
  patchId: number
  isOpen: boolean
  onClose: () => void
}

export const DeletePatchDialog = ({ patchId, isOpen, onClose }: Props) => {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    const res = await kunFetchDelete<KunResponse<{}>>('/patch', { patchId })

    if (typeof res === 'string') {
      toast.error(res)
    } else {
      toast.success('删除 Galgame 成功')
      router.push('/')
    }

    onClose()
    setDeleting(false)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="center">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          永久删除 Galgame
        </ModalHeader>
        <ModalBody>
          严重警告, 删除 Galgame 将会删除这个 Galgame 下面所有的评论,
          所有的资源链接, 所有的贡献历史记录, 您确定要删除吗
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            取消
          </Button>
          <Button
            color="danger"
            onPress={handleDelete}
            isDisabled={deleting}
            isLoading={deleting}
          >
            删除
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default DeletePatchDialog
