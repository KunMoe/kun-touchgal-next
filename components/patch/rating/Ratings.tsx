'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { Modal } from '@heroui/modal'
import { Button } from '@heroui/button'
import { Switch } from '@heroui/switch'
import { Plus } from 'lucide-react'
import { kunFetchGet } from '~/utils/kunFetch'
import { KunMasonry } from '~/components/kun/KunMasonry'
import { KunNull } from '~/components/kun/Null'
import { RatingCard } from './RatingCard'
import { RatingCardSkeleton } from './RatingCardSkeleton'
import { RatingModal } from './RatingModal'
import { useDisclosure } from '@heroui/react'
import { useUserStore } from '~/store/userStore'
import { useKunInfiniteList } from '~/hooks/useKunInfiniteList'
import type {
  KunPatchRating,
  KunPatchRatingResponse
} from '~/types/api/galgame'

interface Props {
  id: number
  // 深链 ?ratingId=, 由详情页 tabs 解析后传入; 本组件不订阅 URL, 以免随 ?tab= 变化重渲染
  targetRatingId: number | null
}

interface RatingQuery {
  page: number
  limit: number
  patchId: number
  onlyWithShortSummary: boolean
  targetRatingId: number | null
}

const RATINGS_PER_PAGE = 24

const MASONRY_BREAKPOINTS = {
  default: 3,
  1024: 2,
  640: 1
}

const hasShortSummary = (rating: KunPatchRating) =>
  Boolean(rating.shortSummary?.trim())

const fetchRatingPage = async (query: RatingQuery) => {
  const params: Record<string, string | number> = {
    patchId: query.patchId,
    page: query.page,
    limit: query.limit,
    onlyWithShortSummary: query.onlyWithShortSummary ? 'true' : 'false'
  }
  if (query.targetRatingId) {
    params.targetRatingId = query.targetRatingId
  }
  const res = await kunFetchGet<KunPatchRatingResponse>('/patch/rating', params)
  return typeof res === 'string'
    ? res
    : { items: res.ratings, total: res.total }
}

export const Ratings = ({ id, targetRatingId }: Props) => {
  const user = useUserStore((state) => state.user)
  const list = useKunInfiniteList<KunPatchRating, RatingQuery>({
    query: {
      page: 1,
      limit: RATINGS_PER_PAGE,
      patchId: id,
      onlyWithShortSummary: true,
      targetRatingId
    },
    getId: (rating) => rating.id,
    grow: 'append',
    // 登录态由 cookie 决定, uid 不进查询键: 用户 store 在首帧之后才水合, 首帧 uid 为 0,
    // 若 uid 在键里, 水合后会先发出首帧建好的请求、再因键变了重发一次
    enabled: user.uid > 0,
    fetchPage: fetchRatingPage
  })
  const { setQuery, insertLocal, removeLocal, patchLocal } = list
  const hideNoContent = list.query.onlyWithShortSummary
  const loading = list.status === 'loading'
  const [highlightedRatingId, setHighlightedRatingId] = useState<number | null>(
    null
  )
  const { isOpen, onOpen, onClose } = useDisclosure()
  // 已滚动定位过的深链 ratingId: 同一目标只滚一次, 否则之后每次无限滚动加载下一页
  // 或切换过滤开关都会把页面拽回目标评价 (tab 保活后目标会一直留在 props 里)
  const scrolledRatingIdRef = useRef<number | null>(null)

  useEffect(() => {
    setQuery({ patchId: id, targetRatingId })
  }, [setQuery, id, targetRatingId])

  useEffect(() => {
    if (
      loading ||
      !targetRatingId ||
      scrolledRatingIdRef.current === targetRatingId
    ) {
      return
    }

    const targetElement = document.getElementById(`rating-${targetRatingId}`)
    if (!targetElement) {
      return
    }

    let raf = 0
    let attempts = 0
    let lastTop = Number.NaN

    const performScroll = () => {
      scrolledRatingIdRef.current = targetRatingId
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedRatingId(targetRatingId)
    }

    const waitForLayout = () => {
      const top = targetElement.getBoundingClientRect().top
      if (attempts > 0 && Math.abs(top - lastTop) < 1) {
        performScroll()
        return
      }
      if (attempts >= 30) {
        performScroll()
        return
      }
      lastTop = top
      attempts += 1
      raf = requestAnimationFrame(waitForLayout)
    }

    raf = requestAnimationFrame(waitForLayout)

    return () => cancelAnimationFrame(raf)
  }, [list.items, loading, targetRatingId])

  // 高亮计时独立于定位 effect: 后者重跑时会提前返回, 不能靠它的 cleanup 清计时器
  useEffect(() => {
    if (highlightedRatingId === null) {
      return
    }

    const timer = window.setTimeout(() => setHighlightedRatingId(null), 3500)
    return () => window.clearTimeout(timer)
  }, [highlightedRatingId])

  const handleCreated = useCallback(
    (rating?: KunPatchRating) => {
      if (rating && (!hideNoContent || hasShortSummary(rating))) {
        insertLocal(rating, 'start')
      }
    },
    [hideNoContent, insertLocal]
  )

  const handlePatchUpdated = useCallback(
    (rating: KunPatchRating) => {
      if (
        hideNoContent &&
        !hasShortSummary(rating) &&
        rating.id !== targetRatingId
      ) {
        removeLocal([rating.id])
        return
      }

      patchLocal(rating.id, rating)
    },
    [hideNoContent, targetRatingId, removeLocal, patchLocal]
  )

  const handleDeleted = useCallback(
    (ratingId: number) => removeLocal([ratingId]),
    [removeLocal]
  )

  if (!user.uid) {
    return <KunNull message="请登录后查看游戏评价" />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Switch
          isSelected={hideNoContent}
          onValueChange={(value) => setQuery({ onlyWithShortSummary: value })}
          size="sm"
        >
          隐藏无短评评价
        </Switch>
        <Button
          color="primary"
          variant="flat"
          startContent={<Plus className="size-4" />}
          onPress={onOpen}
        >
          发布评价
        </Button>
      </div>

      <KunMasonry breakpointCols={MASONRY_BREAKPOINTS} gap={16}>
        {[
          // 过滤开关刚切换时手里的行属于旧的筛选, 新的第一页落地前只画骨架
          ...(list.isStale ? [] : list.items).map((rating) => (
            <div
              key={`rating-${rating.id}`}
              id={`rating-${rating.id}`}
              className={
                highlightedRatingId === rating.id
                  ? 'rounded-large ring-2 ring-primary ring-offset-2 ring-offset-background'
                  : undefined
              }
            >
              <RatingCard
                rating={rating}
                patchId={id}
                onRatingUpdated={handlePatchUpdated}
                onDeleted={handleDeleted}
              />
            </div>
          )),
          ...(loading
            ? Array.from({ length: 6 }).map((_, index) => (
                <div key={`skeleton-${index}`}>
                  <RatingCardSkeleton />
                </div>
              ))
            : [])
        ]}
      </KunMasonry>

      <div ref={list.sentinelRef} className="w-full h-4" />

      {list.status === 'ready' && !list.items.length && (
        <KunNull
          message={
            hideNoContent
              ? '暂无有短评的评价，关闭过滤开关可查看全部评价'
              : '这个游戏还没有评价'
          }
        />
      )}

      {/* 失败即停: 不再自动加载、不加重试按钮 (#23), 刷新页面恢复 */}
      {list.status === 'error' && (
        <p className="text-center text-danger text-sm">{list.error}</p>
      )}

      {list.status === 'ready' && !list.hasMore && list.items.length > 0 && (
        <p className="text-center text-default-500 text-sm">
          已加载全部 {list.total} 条评价
        </p>
      )}

      <Modal
        isOpen={isOpen}
        onClose={onClose}
        isDismissable={false}
        isKeyboardDismissDisabled={true}
      >
        <RatingModal
          isOpen={isOpen}
          onClose={onClose}
          patchId={id}
          onSuccess={handleCreated}
        />
      </Modal>
    </div>
  )
}
