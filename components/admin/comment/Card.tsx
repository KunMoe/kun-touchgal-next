import { Checkbox, Chip } from '@heroui/react'
import { KunAvatar } from '~/components/kun/floating-card/KunAvatar'
import { Card, CardBody } from '@heroui/card'
import { ThumbsUp } from 'lucide-react'
import { formatDate } from '~/utils/time'
import Link from 'next/link'
import { CommentEdit } from './CommentEdit'
import type { AdminComment } from '~/types/api/admin'
import { COMMENT_STATUS } from '~/constants/contentStatus'

interface Props {
  comment: AdminComment
  isSelected: boolean
  isSelectionDisabled?: boolean
  onSelectionChange: (isSelected: boolean) => void
  onUpdated: (comment: AdminComment) => void
  onDeleted: (commentIds: number[]) => void
}

export const CommentCard = ({
  comment,
  isSelected,
  isSelectionDisabled,
  onSelectionChange,
  onUpdated,
  onDeleted
}: Props) => {
  return (
    <Card className={isSelected ? 'ring-2 ring-primary-300' : undefined}>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-1 gap-4">
            <div className="relative flex-shrink-0 min-w-12 pb-6">
              <KunAvatar
                uid={comment.user.id}
                avatarProps={{
                  name: comment.user.name,
                  src: comment.user.avatar
                }}
              />
              <Checkbox
                aria-label={`选择评论 ${comment.id}`}
                className="absolute left-0 bottom-0"
                isDisabled={isSelectionDisabled}
                isSelected={isSelected}
                onValueChange={onSelectionChange}
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">{comment.user.name}</h2>
                {comment.status === COMMENT_STATUS.pending && (
                  <Chip color="warning" variant="flat" size="sm">
                    待审核
                  </Chip>
                )}
                {comment.status === COMMENT_STATUS.hidden && (
                  <Chip color="danger" variant="flat" size="sm">
                    已隐藏
                  </Chip>
                )}
                <span className="text-small text-default-500">
                  评论在{' '}
                  <Link
                    className="text-primary-500"
                    href={`/${comment.uniqueId}`}
                  >
                    {comment.patchName}
                  </Link>
                </span>
              </div>
              <p className="mt-1">{comment.content}</p>
              <div className="flex items-center gap-4 mt-2">
                <div className="flex items-center gap-1 text-small text-default-500">
                  <ThumbsUp size={14} />
                  {comment.like}
                </div>
                <span className="text-small text-default-500">
                  {formatDate(comment.created, {
                    isPrecise: true,
                    isShowYear: true
                  })}
                </span>
              </div>
            </div>
          </div>

          <CommentEdit
            initialComment={comment}
            onUpdated={onUpdated}
            onDeleted={onDeleted}
          />
        </div>
      </CardBody>
    </Card>
  )
}
