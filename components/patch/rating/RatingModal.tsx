'use client'

import { useEffect, useState } from 'react'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/modal'
import { Button, Input, Select, SelectItem, Textarea } from '@heroui/react'
import toast from 'react-hot-toast'
import { kunFetchPost, kunFetchPut } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import {
  KUN_GALGAME_RATING_RECOMMEND_CONST,
  KUN_GALGAME_RATING_RECOMMEND_MAP,
  KUN_GALGAME_RATING_PLAY_STATUS_CONST,
  KUN_GALGAME_RATING_PLAY_STATUS_MAP,
  KUN_GALGAME_RATING_SPOILER_CONST,
  KUN_GALGAME_RATING_SPOILER_MAP
} from '~/constants/galgame'
import type {
  KunPatchRating,
  KunPatchRatingInput,
  KunPatchRatingUpdateInput
} from '~/types/api/galgame'

interface PropsBase {
  isOpen: boolean
  onClose: () => void
  onSuccess?: (rating: KunPatchRating) => void
}

interface CreateProps extends PropsBase {
  patchId: number
  initial?: undefined
}

interface EditProps extends PropsBase {
  patchId: number
  initial: KunPatchRating
}

type Props = CreateProps | EditProps

export const RatingModal = ({
  isOpen,
  onClose,
  onSuccess,
  patchId,
  initial
}: Props) => {
  const [loading, setLoading] = useState(false)

  const [recommend, setRecommend] = useState<string>(
    initial?.recommend ?? 'neutral'
  )
  const [overall, setOverall] = useState<number>(initial?.overall ?? 8)
  const [playStatus, setPlayStatus] = useState<string>(
    initial?.playStatus ?? 'in_progress'
  )
  const [shortSummary, setShortSummary] = useState<string>(
    initial?.shortSummary ?? ''
  )
  const [spoilerLevel, setSpoilerLevel] = useState<string>(
    initial?.spoilerLevel ?? 'none'
  )

  useEffect(() => {
    if (initial) {
      setRecommend(initial.recommend)
      setOverall(initial.overall)
      setPlayStatus(initial.playStatus)
      setShortSummary(initial.shortSummary)
      setSpoilerLevel(initial.spoilerLevel)
    } else {
      setRecommend('neutral')
      setOverall(8)
      setPlayStatus('in_progress')
      setShortSummary('')
      setSpoilerLevel('none')
    }
  }, [initial, isOpen])

  const handleSubmit = async () => {
    if (!Number.isInteger(overall) || overall < 1 || overall > 10) {
      toast.error('评分须为 1～10 的整数')
      return
    }
    setLoading(true)

    if (!initial) {
      const res = await kunFetchPost<KunResponse<KunPatchRating>>(
        '/patch/rating',
        {
          patchId,
          recommend: recommend as 'no',
          overall,
          playStatus: playStatus as 'not_started',
          shortSummary,
          spoilerLevel: spoilerLevel as 'none'
        } satisfies KunPatchRatingInput
      )
      setLoading(false)
      kunErrorHandler(res, (rating) => {
        toast.success('发布评价成功')
        onSuccess?.(rating)
        onClose()
      })
    } else {
      const res = await kunFetchPut<KunResponse<KunPatchRating>>(
        '/patch/rating',
        {
          ratingId: initial.id,
          recommend: recommend as 'no',
          overall,
          playStatus: playStatus as 'not_started',
          shortSummary,
          spoilerLevel: spoilerLevel as 'none'
        } satisfies KunPatchRatingUpdateInput
      )
      setLoading(false)
      kunErrorHandler(res, (value) => {
        toast.success('更新评价成功')
        onSuccess?.(value)
        onClose()
      })
    }
  }

  return (
    <ModalContent>
      <ModalHeader className="flex flex-col gap-1">
        {initial ? '编辑评分' : '撰写评分'}
      </ModalHeader>
      <ModalBody className="gap-4">
        <Select
          label="推荐程度"
          selectedKeys={new Set([recommend])}
          onSelectionChange={(keys) => {
            const v = Array.from(keys)[0] as string
            setRecommend(v)
          }}
        >
          {KUN_GALGAME_RATING_RECOMMEND_CONST.map((k) => (
            <SelectItem key={k} textValue={KUN_GALGAME_RATING_RECOMMEND_MAP[k]}>
              {KUN_GALGAME_RATING_RECOMMEND_MAP[k]}
            </SelectItem>
          ))}
        </Select>

        <Input
          type="number"
          label="总分 (1-10)"
          min={1}
          max={10}
          value={String(overall)}
          onValueChange={(v) => setOverall(Number(v))}
        />

        <Select
          label="游玩状态"
          selectedKeys={new Set([playStatus])}
          onSelectionChange={(keys) => {
            const v = Array.from(keys)[0] as string
            setPlayStatus(v)
          }}
        >
          {KUN_GALGAME_RATING_PLAY_STATUS_CONST.map((k) => (
            <SelectItem
              key={k}
              textValue={KUN_GALGAME_RATING_PLAY_STATUS_MAP[k]}
            >
              {KUN_GALGAME_RATING_PLAY_STATUS_MAP[k]}
            </SelectItem>
          ))}
        </Select>

        <Textarea
          label="简评"
          placeholder="最多 1314 字"
          value={shortSummary}
          onValueChange={setShortSummary}
          maxRows={10}
        />

        <Select
          label="剧透等级"
          selectedKeys={new Set([spoilerLevel])}
          onSelectionChange={(keys) => {
            const v = Array.from(keys)[0] as string
            setSpoilerLevel(v)
          }}
        >
          {KUN_GALGAME_RATING_SPOILER_CONST.map((k) => (
            <SelectItem key={k} textValue={KUN_GALGAME_RATING_SPOILER_MAP[k]}>
              {KUN_GALGAME_RATING_SPOILER_MAP[k]}
            </SelectItem>
          ))}
        </Select>
      </ModalBody>
      <ModalFooter>
        <Button variant="light" onPress={onClose}>
          取消
        </Button>
        <Button
          color="primary"
          onPress={handleSubmit}
          isDisabled={loading}
          isLoading={loading}
        >
          {initial ? '保存修改' : '提交评分'}
        </Button>
      </ModalFooter>
    </ModalContent>
  )
}
