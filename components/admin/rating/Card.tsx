import { Checkbox, Chip } from '@heroui/react'
import { KunAvatar } from '~/components/kun/floating-card/KunAvatar'
import { Card, CardBody } from '@heroui/card'
import { ThumbsUp } from 'lucide-react'
import { formatDate } from '~/utils/time'
import Link from 'next/link'
import { RatingEdit } from './RatingEdit'
import type { AdminRating } from '~/types/api/admin'
import { RATING_STATUS } from '~/constants/contentStatus'

const recommendLabel: Record<string, string> = {
  strong_yes: '强烈推荐',
  yes: '推荐',
  neutral: '中立',
  no: '不推荐',
  strong_no: '强烈不推荐'
}

const recommendColor: Record<
  string,
  'success' | 'primary' | 'default' | 'warning' | 'danger'
> = {
  strong_yes: 'success',
  yes: 'primary',
  neutral: 'default',
  no: 'warning',
  strong_no: 'danger'
}

const playStatusLabel: Record<string, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  finished_one: '通关一次',
  finished_main: '主线通关',
  finished_all: '全线通关',
  dropped: '已弃坑'
}

const spoilerLabel: Record<string, string> = {
  none: '无剧透',
  portion: '部分剧透',
  serious: '严重剧透'
}

interface Props {
  rating: AdminRating
  isSelected: boolean
  isSelectionDisabled?: boolean
  onSelectionChange: (isSelected: boolean) => void
  onUpdated: (rating: AdminRating) => void
  onDeleted: (ratingId: number) => void
}

export const RatingCard = ({
  rating,
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
                uid={rating.user.id}
                avatarProps={{
                  name: rating.user.name,
                  src: rating.user.avatar
                }}
              />
              <Checkbox
                aria-label={`选择评价 ${rating.id}`}
                className="absolute left-0 bottom-0"
                isDisabled={isSelectionDisabled}
                isSelected={isSelected}
                onValueChange={onSelectionChange}
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-semibold">{rating.user.name}</h2>
                {rating.status === RATING_STATUS.pending && (
                  <Chip color="warning" variant="flat" size="sm">
                    待审核
                  </Chip>
                )}
                {rating.status === RATING_STATUS.hidden && (
                  <Chip color="danger" variant="flat" size="sm">
                    已隐藏
                  </Chip>
                )}
                <span className="text-small text-default-500">
                  评价在{' '}
                  <Link
                    className="text-primary-500"
                    href={`/${rating.uniqueId}`}
                  >
                    {rating.patchName}
                  </Link>
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <Chip
                  color={recommendColor[rating.recommend] ?? 'default'}
                  variant="flat"
                  size="sm"
                >
                  {recommendLabel[rating.recommend] ?? rating.recommend}
                </Chip>
                <Chip variant="flat" size="sm">
                  评分 {rating.overall}/10
                </Chip>
                <span className="text-tiny text-default-600">
                  {playStatusLabel[rating.playStatus] ?? rating.playStatus}
                </span>
                {rating.spoilerLevel !== 'none' && (
                  <span className="text-tiny text-warning-500">
                    {spoilerLabel[rating.spoilerLevel] ?? rating.spoilerLevel}
                  </span>
                )}
              </div>
              <p className="mt-1">{rating.shortSummary}</p>
              <div className="flex items-center gap-4 mt-2">
                <div className="flex items-center gap-1 text-small text-default-500">
                  <ThumbsUp size={14} />
                  {rating.like}
                </div>
                <span className="text-small text-default-500">
                  {formatDate(rating.created, {
                    isPrecise: true,
                    isShowYear: true
                  })}
                </span>
              </div>
            </div>
          </div>

          <RatingEdit
            initialRating={rating}
            onUpdated={onUpdated}
            onDeleted={onDeleted}
          />
        </div>
      </CardBody>
    </Card>
  )
}
