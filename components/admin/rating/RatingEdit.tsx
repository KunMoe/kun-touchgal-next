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
import { useUserStore } from '~/store/userStore'
import { kunFetchDelete, kunFetchGet, kunFetchPut } from '~/utils/kunFetch'
import type { AdminRating } from '~/types/api/admin'
import toast from 'react-hot-toast'

interface Props {
  initialRating: AdminRating
  onUpdated?: (rating: AdminRating) => void
  onDeleted?: (ratingId: number) => void
}

export const RatingEdit = ({ initialRating, onUpdated, onDeleted }: Props) => {
  const currentUser = useUserStore((state) => state.user)

  const {
    isOpen: isOpenDelete,
    onOpen: onOpenDelete,
    onClose: onCloseDelete
  } = useDisclosure()
  const [deleting, setDeleting] = useState(false)
  const handleDeleteRating = async () => {
    setDeleting(true)
    try {
      const res = await kunFetchDelete<KunResponse<{}>>('/admin/rating', {
        ratingIds: String(initialRating.id)
      })
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        onCloseDelete()
        toast.success('评价删除成功')
        onDeleted?.(initialRating.id)
      }
    } finally {
      setDeleting(false)
    }
  }

  const isHidden = initialRating.status === 2
  const [hiding, setHiding] = useState(false)
  const handleUpdateStatus = async (status: number) => {
    setHiding(true)
    try {
      const res = await kunFetchPut<KunResponse<{}>>(
        '/admin/rating/shadow-ban',
        {
          ratingId: initialRating.id,
          status
        }
      )
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        toast.success(status === 0 ? '已恢复该评价' : '已隐藏该评价')
        onUpdated?.({ ...initialRating, status })
      }
    } finally {
      setHiding(false)
    }
  }

  const {
    isOpen: isOpenEdit,
    onOpen: onOpenEdit,
    onClose: onCloseEdit
  } = useDisclosure()
  const [editContent, setEditContent] = useState('')
  const [updating, setUpdating] = useState(false)
  const [fetchingFull, setFetchingFull] = useState(false)
  const handleOpenEdit = async () => {
    setFetchingFull(true)
    try {
      const res = await kunFetchGet<{ shortSummary: string }>(
        '/admin/rating/full',
        { ratingId: initialRating.id }
      )
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        setEditContent(res.shortSummary)
        onOpenEdit()
      }
    } finally {
      setFetchingFull(false)
    }
  }
  const handleUpdateRating = async () => {
    if (!editContent.trim()) {
      toast.error('评价内容不可为空')
      return
    }
    setUpdating(true)
    try {
      const res = await kunFetchPut<KunResponse<AdminRating>>('/admin/rating', {
        ratingId: initialRating.id,
        shortSummary: editContent.trim()
      })
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        onCloseEdit()
        setEditContent('')
        toast.success('更新评价成功!')
        // 与服务端列表一致: 展示 233 字截断预览
        onUpdated?.({
          ...initialRating,
          shortSummary: editContent.trim().slice(0, 233)
        })
      }
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
            aria-label="评价操作菜单"
            size="sm"
            variant="light"
            isDisabled={currentUser.role < 3}
          >
            <MoreVertical size={16} />
          </Button>
        </DropdownTrigger>
        <DropdownMenu>
          <DropdownItem
            key="edit"
            isDisabled={fetchingFull}
            onPress={handleOpenEdit}
          >
            编辑
          </DropdownItem>
          <DropdownItem
            key="hidden"
            className="text-warning"
            color="warning"
            isDisabled={hiding}
            onPress={() => handleUpdateStatus(isHidden ? 0 : 2)}
          >
            {isHidden ? '取消隐藏' : '隐藏'}
          </DropdownItem>
          <DropdownItem
            key="delete"
            className="text-danger"
            color="danger"
            onPress={onOpenDelete}
          >
            删除
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>

      <Modal isOpen={isOpenEdit} onClose={onCloseEdit} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">编辑评价</ModalHeader>
          <ModalBody>
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              minRows={2}
              maxRows={8}
            />
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              onPress={() => {
                setEditContent('')
                onCloseEdit()
              }}
            >
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleUpdateRating}
              disabled={updating}
              isLoading={updating}
            >
              确定
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={isOpenDelete} onClose={onCloseDelete} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">删除评价</ModalHeader>
          <ModalBody>
            <p>您确定要删除这条评价吗, 该操作不可撤销</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onCloseDelete}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteRating}
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
