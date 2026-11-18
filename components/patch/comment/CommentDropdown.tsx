'use client'

import { SetStateAction, useState } from 'react'
import { Button } from '@heroui/button'
import { Dropdown, DropdownMenu, DropdownTrigger } from '@heroui/dropdown'
import {
  EyeOff,
  MoreHorizontal,
  Pencil,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { DropdownItem } from '@heroui/dropdown'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { Textarea } from '@heroui/input'
import { Switch } from '@heroui/switch'
import { KunMarkdownEditor } from '~/components/kun/editor/MarkdownEditor'
import {
  kunFetchDelete,
  kunFetchGet,
  kunFetchPost,
  kunFetchPut
} from '~/utils/kunFetch'
import toast from 'react-hot-toast'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { useUserStore } from '~/store/userStore'
import { can } from '~/constants/permission'
import type { PatchComment } from '~/types/api/patch'

interface Props {
  comment: PatchComment
  setComments: (comments: SetStateAction<PatchComment[]>) => void
  onDeleted: (comment: PatchComment) => void
}

export const CommentDropdown = ({ comment, setComments, onDeleted }: Props) => {
  const user = useUserStore((state) => state.user)
  const isPending = comment.status === 1

  const [editContent, setEditContent] = useState('')
  const [editIsSpoiler, setEditIsSpoiler] = useState(false)
  const [updating, setUpdating] = useState(false)
  const {
    isOpen: isOpenEdit,
    onOpen: onOpenEdit,
    onClose: onCloseEdit
  } = useDisclosure()
  const handleStartEdit = async () => {
    const res = await kunFetchGet<
      KunResponse<{ content: string; isSpoiler: boolean }>
    >('/patch/comment/markdown', { commentId: comment.id })
    if (typeof res === 'string') {
      toast.error(res)
      return
    } else {
      setEditContent(res.content)
      setEditIsSpoiler(res.isSpoiler ?? comment.isSpoiler ?? false)
      onOpenEdit()
    }
  }
  const handleUpdateComment = async (commentId: number) => {
    if (!editContent.trim()) {
      toast.error('评论内容不可为空')
      return
    }

    setUpdating(true)
    const res = await kunFetchPut<
      KunResponse<{ contentHtml: string; contentPreview: string }>
    >('/patch/comment', {
      commentId,
      content: editContent.trim(),
      isSpoiler: editIsSpoiler
    })
    kunErrorHandler(res, (data) => {
      setEditContent('')
      setComments((prev) =>
        prev.map((c) => {
          if (c.id === commentId) {
            return {
              ...c,
              content: data.contentHtml,
              contentPreview: data.contentPreview,
              isSpoiler: editIsSpoiler
            }
          }
          if (c.reply.some((r) => r.id === commentId)) {
            return {
              ...c,
              reply: c.reply.map((r) =>
                r.id === commentId
                  ? {
                      ...r,
                      content: data.contentHtml,
                      contentPreview: data.contentPreview,
                      isSpoiler: editIsSpoiler
                    }
                  : r
              )
            }
          }
          return c
        })
      )
      onCloseEdit()
      toast.success('更新评论成功!')
    })

    setUpdating(false)
  }

  const {
    isOpen: isOpenDelete,
    onOpen: onOpenDelete,
    onClose: onCloseDelete
  } = useDisclosure()
  const [deleting, setDeleting] = useState(false)
  const handleDeleteComment = async () => {
    setDeleting(true)
    const res = await kunFetchDelete<KunResponse<{}>>('/patch/comment', {
      commentId: comment.id
    })
    kunErrorHandler(res, () => {
      onCloseDelete()
      onDeleted(comment)
      toast.success('评论删除成功')
    })
    setDeleting(false)
  }

  const {
    isOpen: isOpenReport,
    onOpen: onOpenReport,
    onClose: onCloseReport
  } = useDisclosure()
  const [reportValue, setReportValue] = useState('')
  const [reporting, setReporting] = useState(false)
  const handleSubmitReport = async () => {
    setReporting(true)
    const res = await kunFetchPost<KunResponse<{}>>('/patch/comment/report', {
      commentId: comment.id,
      patchId: comment.patchId,
      content: reportValue
    })
    if (typeof res === 'string') {
      toast.error(res)
    } else {
      setReportValue('')
      toast.success('提交举报成功')
    }
    onCloseReport()
    setReporting(false)
  }

  return (
    <>
      <Dropdown>
        <DropdownTrigger>
          <Button variant="light" isIconOnly className="text-default-400">
            <MoreHorizontal aria-label="Galgame 评论操作" className="size-4" />
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label="Comment actions"
          disabledKeys={
            isPending
              ? ['edit', 'delete', 'report']
              : user.uid !== comment.userId && !can(user, 'content.moderateAny')
                ? ['edit', 'delete']
                : ['report']
          }
        >
          <DropdownItem
            key="edit"
            color="default"
            startContent={<Pencil className="size-4" />}
            onPress={handleStartEdit}
          >
            编辑评论
          </DropdownItem>
          <DropdownItem
            key="delete"
            className="text-danger"
            color="danger"
            startContent={<Trash2 className="size-4" />}
            onPress={onOpenDelete}
          >
            删除评论
          </DropdownItem>
          <DropdownItem
            key="report"
            startContent={<TriangleAlert className="size-4" />}
            onPress={onOpenReport}
          >
            举报评论
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>

      <Modal isOpen={isOpenEdit} onClose={onCloseEdit} size="2xl">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            重新编辑评论
          </ModalHeader>
          <ModalBody>
            <KunMarkdownEditor
              value={editContent}
              onChange={setEditContent}
              minHeight={160}
            />
            <Switch
              isSelected={editIsSpoiler}
              onValueChange={setEditIsSpoiler}
              color="warning"
              size="sm"
              thumbIcon={<EyeOff className="size-3" />}
            >
              <span className="text-sm text-default-600">剧透评论</span>
            </Switch>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onCloseEdit}>
              取消
            </Button>
            <Button
              color="primary"
              onPress={() => handleUpdateComment(comment.id)}
              isDisabled={updating}
              isLoading={updating}
            >
              保存
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
            <p className="pl-4 border-l-4 border-primary-500">
              {comment.contentPreview ?? ''}
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

      <Modal isOpen={isOpenReport} onClose={onCloseReport}>
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">举报评论</ModalHeader>
          <ModalBody>
            <Textarea
              label={`举报 ${(comment.contentPreview ?? '').slice(0, 20)}`}
              isRequired
              placeholder="请填写举报原因"
              value={reportValue}
              onChange={(e) => setReportValue(e.target.value)}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onCloseReport}>
              取消
            </Button>
            <Button
              color="primary"
              onPress={handleSubmitReport}
              isDisabled={reporting}
              isLoading={reporting}
            >
              提交
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
