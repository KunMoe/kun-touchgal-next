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
import { markdownToText } from '~/utils/markdownToText'
import type { AdminComment } from '~/types/api/admin'
import toast from 'react-hot-toast'

interface Props {
  initialComment: AdminComment
  onUpdated?: (comment: AdminComment) => void
  // 删除会级联带走整棵回复子树, 回传实际删除的全部 id
  onDeleted?: (commentIds: number[]) => void
}

export const CommentEdit = ({
  initialComment,
  onUpdated,
  onDeleted
}: Props) => {
  const currentUser = useUserStore((state) => state.user)

  const {
    isOpen: isOpenDelete,
    onOpen: onOpenDelete,
    onClose: onCloseDelete
  } = useDisclosure()
  const [deleting, setDeleting] = useState(false)
  const handleDeleteComment = async () => {
    setDeleting(true)
    try {
      const res = await kunFetchDelete<KunResponse<{ deletedIds: number[] }>>(
        '/admin/comment',
        {
          commentIds: String(initialComment.id)
        }
      )
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        onCloseDelete()
        toast.success('评论删除成功')
        onDeleted?.(res.deletedIds)
      }
    } finally {
      setDeleting(false)
    }
  }

  const isHidden = initialComment.status === 2
  const [hiding, setHiding] = useState(false)
  const handleUpdateStatus = async (status: number) => {
    setHiding(true)
    try {
      const res = await kunFetchPut<KunResponse<{}>>(
        '/admin/comment/shadow-ban',
        {
          commentId: initialComment.id,
          status
        }
      )
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        toast.success(status === 0 ? '已恢复该评论' : '已隐藏该评论')
        onUpdated?.({ ...initialComment, status })
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
      const res = await kunFetchGet<{ content: string }>(
        '/admin/comment/full',
        { commentId: initialComment.id }
      )
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        setEditContent(res.content)
        onOpenEdit()
      }
    } finally {
      setFetchingFull(false)
    }
  }
  const handleUpdateComment = async () => {
    if (!editContent.trim()) {
      toast.error('评论内容不可为空')
      return
    }
    setUpdating(true)
    try {
      const res = await kunFetchPut<KunResponse<AdminComment>>(
        '/admin/comment',
        {
          commentId: initialComment.id,
          content: editContent.trim()
        }
      )
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        onCloseEdit()
        setEditContent('')
        toast.success('更新评论成功!')
        // 与服务端列表一致: 展示 markdown 转纯文本后的 233 字预览
        onUpdated?.({
          ...initialComment,
          content: markdownToText(editContent.trim()).slice(0, 233)
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
            aria-label="评论操作菜单"
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
          <ModalHeader className="flex flex-col gap-1">编辑评论</ModalHeader>
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
              onPress={handleUpdateComment}
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
          <ModalHeader className="flex flex-col gap-1">删除评论</ModalHeader>
          <ModalBody>
            <p>
              您确定要删除这条评论吗, 这将会删除该评论,
              以及所有回复该评论的评论, 该操作不可撤销
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onCloseDelete}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteComment}
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
