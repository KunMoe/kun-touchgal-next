'use client'

import { Avatar, Button, Card, CardBody, Chip } from '@heroui/react'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import toast from 'react-hot-toast'
import { kunFetchPut } from '~/utils/kunFetch'
import { buildCommentLink } from '~/utils/patch/buildCommentLink'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { APPEAL_STATUS_MAP } from '~/constants/appeal'
import { MODERATION_CONTENT_TYPE_MAP } from '~/constants/moderation'
import type { AdminAppealItem, AppealPayload } from '~/types/api/appeal'

const statusColorMap: Record<string, 'warning' | 'success' | 'danger'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger'
}

// comment / rating 与站内消息通知的深链格式一致 (createMentionMessage / rating like 等);
// resource 刻意偏离站内信的 ?tab=resources 列表锚点, 直达资源详情页 —— 申诉要看的是
// 这一条资源的完整内容, 可见性口径与列表同为 getResourceVisibilityWhere, 不会多出 404
const contentLinkMap: Partial<
  Record<string, (uniqueId: string, contentId: number) => string>
> = {
  comment: (uniqueId, contentId) =>
    `/${uniqueId}?tab=comments&commentId=${contentId}`,
  rating: (uniqueId, contentId) =>
    `/${uniqueId}?tab=rating&ratingId=${contentId}`,
  resource: (uniqueId, contentId) => `/${uniqueId}/resource/${contentId}`
}

const formatPayload = (contentType: string, payload: AppealPayload) =>
  contentType === 'resource'
    ? `标题：${payload.name}\n介绍：${payload.note}`
    : (payload.text ?? '')

interface Props {
  appeal: AdminAppealItem
  onHandled: (appealId: number, nextStatus: string) => void
}

export const AppealCard = ({ appeal, onHandled }: Props) => {
  const [handling, setHandling] = useState(false)
  const { isOpen, onOpen, onClose } = useDisclosure()

  const handle = async (approve: boolean) => {
    setHandling(true)
    try {
      const res = await kunFetchPut<KunResponse<{}>>('/admin/appeal', {
        appealId: appeal.id,
        approve
      })
      if (typeof res === 'string') {
        toast.error(res)
        return
      }
      toast.success(
        approve ? '申诉已通过, 内容已恢复' : '申诉已拒绝, 内容已删除'
      )
      onClose()
      onHandled(appeal.id, approve ? 'approved' : 'rejected')
    } finally {
      setHandling(false)
    }
  }

  const buildContentLink = contentLinkMap[appeal.contentType]
  const contentLink =
    buildContentLink && appeal.patch
      ? // 评论深链与站内信同源 (资源评论指向资源详情页)
        appeal.contentType === 'comment'
        ? buildCommentLink(
            appeal.patch.uniqueId,
            appeal.contentId,
            appeal.commentResourceId
          )
        : buildContentLink(appeal.patch.uniqueId, appeal.contentId)
      : null

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip color="primary" variant="flat" size="sm">
            {MODERATION_CONTENT_TYPE_MAP[appeal.contentType] ??
              appeal.contentType}
          </Chip>
          <Chip
            color={statusColorMap[appeal.status] ?? 'warning'}
            variant="flat"
            size="sm"
          >
            {APPEAL_STATUS_MAP[appeal.status] ?? appeal.status}
          </Chip>
          {!appeal.original && (
            <Chip color="default" variant="flat" size="sm">
              内容已被删除
            </Chip>
          )}
          <span className="text-sm text-default-500">
            #{appeal.id} · <KunTimeAgo date={appeal.updated} />
          </span>
          {contentLink && (
            <Button
              as={Link}
              href={contentLink}
              target="_blank"
              size="sm"
              color="primary"
              variant="flat"
              className="ml-auto"
              startContent={<ExternalLink className="size-4" />}
            >
              查看内容
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Avatar
            src={appeal.user.avatar}
            size="sm"
            showFallback
            name={appeal.user.name.charAt(0).toUpperCase()}
          />
          <span className="text-sm">{appeal.user.name}</span>
          <span className="text-sm text-default-500">
            内容 ID: {appeal.contentId}
          </span>
        </div>

        {appeal.rejectReason && (
          <p className="text-sm text-danger">
            原审核拒绝原因: {appeal.rejectReason}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-sm text-default-500">原内容</p>
            <p className="whitespace-pre-wrap break-all rounded-lg bg-default-100 p-2 text-sm">
              {appeal.original
                ? formatPayload(appeal.contentType, appeal.original)
                : '(内容已被删除)'}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-default-500">申诉修改后内容</p>
            <p className="whitespace-pre-wrap break-all rounded-lg bg-default-100 p-2 text-sm">
              {formatPayload(appeal.contentType, appeal.payload)}
            </p>
          </div>
        </div>

        {appeal.status === 'pending' && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              color="success"
              variant="flat"
              isLoading={handling}
              isDisabled={!appeal.original}
              onPress={() => handle(true)}
            >
              通过
            </Button>
            <Button
              size="sm"
              color="danger"
              variant="flat"
              isLoading={handling}
              onPress={onOpen}
            >
              拒绝
            </Button>
          </div>
        )}

        <Modal isOpen={isOpen} onClose={onClose} placement="center">
          <ModalContent>
            <ModalHeader>拒绝申诉</ModalHeader>
            <ModalBody>
              <p>
                拒绝申诉将<b>硬删除</b>该
                {MODERATION_CONTENT_TYPE_MAP[appeal.contentType] ?? '内容'}
                （评论会连同其回复一并删除），此操作不可恢复，确定继续吗？
              </p>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                取消
              </Button>
              <Button
                color="danger"
                isLoading={handling}
                onPress={() => handle(false)}
              >
                拒绝并删除
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      </CardBody>
    </Card>
  )
}
