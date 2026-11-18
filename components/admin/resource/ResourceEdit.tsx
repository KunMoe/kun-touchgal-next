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
import { Edit2, Trash2 } from 'lucide-react'
import { kunFetchDelete } from '~/utils/kunFetch'
import { errorReporter } from '~/utils/kunErrorHandler'
import { EditResourceDialog } from '~/components/patch/resource/edit/EditResourceDialog'
import type { AdminResource } from '~/types/api/admin'
import type { PatchResource } from '~/types/api/patch'

interface Props {
  initialResource: AdminResource
  onUpdated?: (resource: PatchResource) => void
  onDeleted?: (resourceId: number) => void
}

export const ResourceEdit = ({
  initialResource,
  onUpdated,
  onDeleted
}: Props) => {
  // 保存后回写: 列表的 initialResource 是服务端快照且不刷新, 若继续用它做
  // 表单初值, 再次编辑同一条会把上次的改动整体回退
  const [resource, setResource] = useState(initialResource)

  const {
    isOpen: isOpenEdit,
    onOpen: onOpenEdit,
    onClose: onCloseEdit
  } = useDisclosure()

  const {
    isOpen: isOpenDelete,
    onOpen: onOpenDelete,
    onClose: onCloseDelete
  } = useDisclosure()
  const [deleting, setDeleting] = useState(false)
  const handleDeleteResource = async () => {
    setDeleting(true)
    try {
      const res = await kunFetchDelete<KunResponse<{}>>('/admin/resource', {
        resourceId: initialResource.id
      })
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        toast.success('删除资源链接成功')
        onDeleted?.(initialResource.id)
      }
      onCloseDelete()
    } catch (error) {
      errorReporter(error)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div className="flex gap-2">
        <Button
          isIconOnly
          aria-label="编辑资源"
          size="sm"
          variant="light"
          onPress={onOpenEdit}
        >
          <Edit2 size={16} />
        </Button>
        <Button
          isIconOnly
          aria-label="删除资源"
          size="sm"
          variant="light"
          color="danger"
          onPress={onOpenDelete}
        >
          <Trash2 size={16} />
        </Button>
      </div>

      <Modal
        size="3xl"
        isOpen={isOpenEdit}
        onClose={onCloseEdit}
        scrollBehavior="outside"
        isDismissable={false}
        isKeyboardDismissDisabled={true}
      >
        <EditResourceDialog
          onClose={onCloseEdit}
          resource={resource}
          onSuccess={(updated) => {
            setResource({ ...resource, ...updated })
            onUpdated?.(updated)
            onCloseEdit()
          }}
          type="admin"
        />
      </Modal>

      <Modal isOpen={isOpenDelete} onClose={onCloseDelete} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            删除资源链接
          </ModalHeader>
          <ModalBody>
            <p>您确定要删除这条资源链接吗, 该操作不可撤销</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onCloseDelete}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteResource}
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
