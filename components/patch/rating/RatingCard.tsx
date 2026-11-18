'use client'

import { memo, useState } from 'react'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Button, Chip, Tooltip, Textarea } from '@heroui/react'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { Eye, EyeOff, Pencil, Star, Trash2, TriangleAlert } from 'lucide-react'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { RatingLikeButton } from './RatingLike'
import { useUserStore } from '~/store/userStore'
import { can } from '~/constants/permission'
import toast from 'react-hot-toast'
import { kunFetchDelete, kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { RatingModal } from './RatingModal'
import {
  KUN_GALGAME_RATING_RECOMMEND_MAP,
  KUN_GALGAME_RATING_PLAY_STATUS_MAP,
  KUN_GALGAME_RATING_SPOILER_MAP
} from '~/constants/galgame'
import type { KunPatchRating } from '~/types/api/galgame'

interface Props {
  rating: KunPatchRating
  patchId: number
  onRatingUpdated: (rating: KunPatchRating) => void
  onDeleted: (ratingId: number) => void
}

const getRecommendColor = (recommend: string) => {
  switch (recommend) {
    case 'strong_yes':
      return 'success'
    case 'yes':
      return 'primary'
    case 'neutral':
      return 'default'
    case 'no':
      return 'warning'
    case 'strong_no':
      return 'danger'
    default:
      return 'default'
  }
}

const getScoreColor = (score: number) => {
  if (score >= 9) return 'text-amber-400'
  if (score >= 7) return 'text-emerald-500'
  if (score >= 5) return 'text-sky-500'
  if (score >= 3) return 'text-orange-400'
  return 'text-rose-500'
}

export const RatingCard = memo(function RatingCard({
  rating,
  patchId,
  onRatingUpdated,
  onDeleted
}: Props) {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const user = useUserStore((state) => state.user)
  const [isShowSummary, setIsShowSummary] = useState(
    rating.spoilerLevel === 'none'
  )
  const {
    isOpen: isOpenReport,
    onOpen: onOpenReport,
    onClose: onCloseReport
  } = useDisclosure()
  const [reportValue, setReportValue] = useState('')
  const [reporting, setReporting] = useState(false)

  const canEdit =
    user.uid === rating.user.id || can(user, 'content.moderateAny')
  const isPending = rating.status === 1

  const {
    isOpen: isOpenDelete,
    onOpen: onOpenDelete,
    onClose: onCloseDelete
  } = useDisclosure()
  const [deleting, setDeleting] = useState(false)
  const handleSubmitReport = async () => {
    if (!reportValue.trim()) {
      toast.error('请填写举报原因')
      return
    }

    setReporting(true)
    const res = await kunFetchPost<KunResponse<{}>>('/patch/rating/report', {
      ratingId: rating.id,
      patchId,
      content: reportValue.trim()
    })
    if (typeof res === 'string') {
      toast.error(res)
    } else {
      setReportValue('')
      onCloseReport()
      toast.success('提交举报成功')
    }
    setReporting(false)
  }

  const handleDeleteRating = async () => {
    if (!canEdit) {
      toast.error('您没有权限删除该评价')
      return
    }

    setDeleting(true)
    try {
      const res = await kunFetchDelete<KunResponse<{}>>('/patch/rating', {
        ratingId: rating.id
      })
      kunErrorHandler(res, () => {
        onDeleted(rating.id)
        onCloseDelete()
        toast.success('Galgame 评价删除成功')
      })
    } catch {
      toast.error('删除评价失败, 请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Card className="w-full">
      <CardHeader className="flex items-start justify-between gap-2 pb-0">
        <div className="ml-1">
          <KunUser
            user={rating.user}
            userProps={{
              name: rating.user.name,
              description: (
                <span className="flex items-center gap-1.5">
                  <span>
                    <KunTimeAgo date={rating.created} />
                  </span>
                  <Chip
                    color={getRecommendColor(rating.recommend)}
                    variant="flat"
                    size="sm"
                    className="h-5 px-1.5"
                  >
                    {KUN_GALGAME_RATING_RECOMMEND_MAP[rating.recommend]}
                  </Chip>
                  <Chip
                    color="secondary"
                    variant="flat"
                    size="sm"
                    className="h-5 px-1.5"
                  >
                    {KUN_GALGAME_RATING_PLAY_STATUS_MAP[rating.playStatus]}
                  </Chip>
                  {isPending && (
                    <Tooltip content="审核中，仅你和管理员可见">
                      <Chip
                        color="warning"
                        variant="flat"
                        size="sm"
                        className="h-5 px-1.5"
                      >
                        待审核
                      </Chip>
                    </Tooltip>
                  )}
                </span>
              ),
              avatarProps: {
                src: rating.user.avatar,
                size: 'sm'
              }
            }}
          />
        </div>
        <div
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-default-100 dark:bg-default-50/10 ${getScoreColor(rating.overall)}`}
        >
          <Star className="size-3.5" fill="currentColor" strokeWidth={0} />
          <span className="text-lg font-bold tabular-nums leading-none">
            {rating.overall}
          </span>
        </div>
      </CardHeader>

      <CardBody
        className={rating.shortSummary ? 'py-2 space-y-2' : 'pt-0 pb-1'}
      >
        {rating.shortSummary && (
          <>
            {rating.spoilerLevel !== 'none' && !isShowSummary ? (
              <div
                className="relative p-2 rounded-lg bg-warning-50 dark:bg-warning-100/10 border border-warning-200 dark:border-warning-500/20 cursor-pointer hover:bg-warning-100 dark:hover:bg-warning-100/20 transition-colors"
                onClick={() => setIsShowSummary(true)}
              >
                <div className="flex items-center gap-1.5 text-warning-600 dark:text-warning-500">
                  <EyeOff className="size-3.5" />
                  <span className="text-xs font-medium">
                    {KUN_GALGAME_RATING_SPOILER_MAP[rating.spoilerLevel]}
                    {' — '}点击显示
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                {rating.spoilerLevel !== 'none' && (
                  <div
                    className="relative p-2 rounded-lg bg-warning-50 dark:bg-warning-100/10 border border-warning-200 dark:border-warning-500/20 cursor-pointer hover:bg-warning-100 dark:hover:bg-warning-100/20 transition-colors"
                    onClick={() => setIsShowSummary(false)}
                  >
                    <div className="flex items-center gap-1.5 text-warning-600 dark:text-warning-500">
                      <Eye className="size-3.5" />
                      <span className="text-xs font-medium">
                        {KUN_GALGAME_RATING_SPOILER_MAP[rating.spoilerLevel]}
                        {' — '}点击隐藏
                      </span>
                    </div>
                  </div>
                )}
                <p className="text-sm text-default-800 whitespace-pre-wrap leading-relaxed ml-1">
                  {rating.shortSummary}
                </p>
              </div>
            )}
          </>
        )}
        <div className="flex items-center justify-between">
          <RatingLikeButton rating={rating} isDisabled={isPending} />

          <div className="flex gap-0.5">
            {user.uid > 0 && user.uid !== rating.user.id && (
              <Tooltip content="举报" placement="bottom">
                <Button
                  variant="light"
                  isIconOnly
                  size="sm"
                  isDisabled={isPending}
                  onPress={onOpenReport}
                  className="text-default-500"
                >
                  <TriangleAlert className="size-4" />
                </Button>
              </Tooltip>
            )}
            {canEdit && (
              <>
                <Tooltip content="编辑" placement="bottom">
                  <Button
                    variant="light"
                    isIconOnly
                    size="sm"
                    isDisabled={isPending}
                    onPress={onOpen}
                    className="text-default-500"
                  >
                    <Pencil className="size-4" />
                  </Button>
                </Tooltip>
                <Tooltip content="删除" placement="bottom">
                  <Button
                    variant="light"
                    isIconOnly
                    size="sm"
                    isDisabled={isPending}
                    onPress={onOpenDelete}
                    className="text-danger"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </Tooltip>
              </>
            )}
          </div>
        </div>
      </CardBody>

      <Modal
        isOpen={isOpen}
        onClose={onClose}
        isDismissable={false}
        isKeyboardDismissDisabled={true}
      >
        <RatingModal
          isOpen={isOpen}
          onClose={onClose}
          patchId={patchId}
          onSuccess={onRatingUpdated}
          initial={rating}
        />
      </Modal>

      <Modal isOpen={isOpenDelete} onClose={onCloseDelete} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">删除评价</ModalHeader>
          <ModalBody>
            <p>
              您确定要删除这条评价吗？这将会导致您发布评价获得的萌萌点被扣除，该操作不可撤销。
            </p>
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

      <Modal isOpen={isOpenReport} onClose={onCloseReport}>
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">举报评价</ModalHeader>
          <ModalBody>
            <Textarea
              label={`举报 ${rating.shortSummary.slice(0, 20) || `总分 ${rating.overall}/10`}`}
              isRequired
              placeholder="请填写举报原因"
              value={reportValue}
              onValueChange={setReportValue}
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
    </Card>
  )
})
