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
import { dropLoadedRatings } from './dropLoadedRatings'
import { useDisclosure } from '@heroui/react'
import { useUserStore } from '~/store/userStore'
import type {
  KunPatchRating,
  KunPatchRatingResponse
} from '~/types/api/galgame'

interface Props {
  id: number
  // 深链 ?ratingId=, 由详情页 tabs 解析后传入; 本组件不订阅 URL, 以免随 ?tab= 变化重渲染
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

export const Ratings = ({ id, targetRatingId }: Props) => {
  const [ratings, setRatings] = useState<KunPatchRating[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [initialized, setInitialized] = useState(false)
  const [hideNoContent, setHideNoContent] = useState(true)
  const [highlightedRatingId, setHighlightedRatingId] = useState<number | null>(
    null
  )
  const { isOpen, onOpen, onClose } = useDisclosure()
  const user = useUserStore((state) => state.user)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const requestIdRef = useRef(0)
  // 已滚动定位过的深链 ratingId: 同一目标只滚一次, 否则之后每次无限滚动加载下一页
  // 或切换过滤开关都会把页面拽回目标评价 (tab 保活后目标会一直留在 props 里)
  const scrolledRatingIdRef = useRef<number | null>(null)

  const fetchRatings = useCallback(
    async (pageNum: number, reset = false) => {
      if (!reset && loadingRef.current) return

      const query: Record<string, string | number> = {
        patchId: Number(id),
        page: pageNum,
        limit: RATINGS_PER_PAGE,
        onlyWithShortSummary: hideNoContent ? 'true' : 'false'
      }
      if (targetRatingId) {
        query.targetRatingId = targetRatingId
      }

      const requestId = ++requestIdRef.current
      loadingRef.current = true
      setLoading(true)
      try {
        const res = await kunFetchGet<KunPatchRatingResponse>(
          '/patch/rating',
          query
        )

        if (requestId !== requestIdRef.current) {
          return
        }

        if (res && typeof res !== 'string') {
          if (reset) {
            setRatings(res.ratings)
          } else {
            setRatings((prev) => [
              ...prev,
              ...dropLoadedRatings(prev, res.ratings)
            ])
          }
          setTotal(res.total)
          setHasMore(pageNum * RATINGS_PER_PAGE < res.total)
        }
      } finally {
        if (requestId === requestIdRef.current) {
          loadingRef.current = false
          setLoading(false)
          setInitialized(true)
        }
      }
    },
    [hideNoContent, id, targetRatingId]
  )

  useEffect(() => {
    if (!user.uid) return

    setPage(1)
    setRatings([])
    setTotal(0)
    setHasMore(true)
    setInitialized(false)
    fetchRatings(1, true)
  }, [fetchRatings, user.uid])

  useEffect(() => {
    if (!loadMoreRef.current || !hasMore || loading) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingRef.current) {
          setPage((prev) => prev + 1)
        }
      },
      { threshold: 0.1 }
    )

    observerRef.current.observe(loadMoreRef.current)

    return () => {
      observerRef.current?.disconnect()
    }
  }, [hasMore, loading])

  useEffect(() => {
    if (page > 1) {
      fetchRatings(page)
    }
  }, [fetchRatings, page])

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
  }, [ratings, loading, targetRatingId])

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
        setRatings((prev) => [rating, ...prev])
        setTotal((prev) => prev + 1)
      }
    },
    [hideNoContent]
  )

  const handlePatchUpdated = useCallback(
    (rating: KunPatchRating) => {
      if (
        hideNoContent &&
        !hasShortSummary(rating) &&
        rating.id !== targetRatingId
      ) {
        setRatings((prev) => prev.filter((r) => r.id !== rating.id))
        setTotal((prev) => Math.max(0, prev - 1))
        return
      }

      setRatings((prev) => prev.map((r) => (r.id === rating.id ? rating : r)))
    },
    [hideNoContent, targetRatingId]
  )

  const handleDeleted = useCallback((ratingId: number) => {
    setRatings((prev) => prev.filter((r) => r.id !== ratingId))
    setTotal((prev) => Math.max(0, prev - 1))
  }, [])

  if (!user.uid) {
    return <KunNull message="请登录后查看游戏评价" />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Switch
          isSelected={hideNoContent}
          onValueChange={setHideNoContent}
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
          ...ratings.map((rating) => (
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
          ...(!initialized || loading
            ? Array.from({ length: 6 }).map((_, index) => (
                <div key={`skeleton-${index}`}>
                  <RatingCardSkeleton />
                </div>
              ))
            : [])
        ]}
      </KunMasonry>

      <div ref={loadMoreRef} className="w-full h-4" />

      {initialized && !ratings.length && !loading && (
        <KunNull
          message={
            hideNoContent
              ? '暂无有短评的评价，关闭过滤开关可查看全部评价'
              : '这个游戏还没有评价'
          }
        />
      )}

      {!hasMore && ratings.length > 0 && (
        <p className="text-center text-default-500 text-sm">
          已加载全部 {total} 条评价
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
