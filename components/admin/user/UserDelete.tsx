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
import type {
  AdminUser,
  AdminUserDeletionRemaining,
  AdminUserDeletionResult
} from '~/types/api/admin'

interface Props {
  user: AdminUser
  // 一次没删完时账号已被封禁, 用它就地更新这一行的状态
  onUpdated?: (user: AdminUser) => void
  onDeleted?: (uid: number) => void
}

const PURGED_LABEL: Record<
  keyof AdminUserDeletionRemaining,
  (count: number) => string
> = {
  'patch.user_id': (count) => `Galgame ${count} 个`,
  'patch_resource.user_id': (count) => `资源 ${count} 条`,
  'patch_comment.user_id': (count) => `评论 ${count} 条`,
  'patch_rating.user_id': (count) => `评价 ${count} 条`
}

const PURGED_ORDER = Object.keys(PURGED_LABEL) as Array<
  keyof AdminUserDeletionRemaining
>

export const UserDelete = ({ user, onUpdated, onDeleted }: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [deleting, setDeleting] = useState(false)
  // 内容多的账号一次请求删不完: 服务端已封禁该用户、删了一部分, 弹窗保持打开, 再点一次续上
  const [remaining, setRemaining] = useState<AdminUserDeletionRemaining | null>(
    null
  )
  const handleUpdateUserInfo = async () => {
    setDeleting(true)
    try {
      const res = await kunFetchDelete<KunResponse<AdminUserDeletionResult>>(
        '/admin/user',
        { uid: user.id }
      )
      if (typeof res !== 'string' && !res.done) {
        setRemaining(res.remaining)
        onUpdated?.({ ...user, status: 2 })
        return
      }
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
              {remaining && (
                <p className="text-warning">
                  已封禁该用户并删除了一部分内容, 还剩{' '}
                  {PURGED_ORDER.filter((ref) => remaining[ref])
                    .map((ref) => PURGED_LABEL[ref](remaining[ref] ?? 0))
                    .join('、')}
                  , 请点击「继续删除」
                </p>
              )}
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
              {remaining ? '继续删除' : '永久删除用户'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
