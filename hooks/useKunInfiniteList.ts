import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { type KunListQuery } from '~/utils/list/kunListMachine'
import { useKunListCore, type KunListHookOptions } from './useKunListCore'

// 无限滚动列表 (评价瀑布流、私聊历史)。哨兵进入视口只发「加载下一页」的意图, 发不发由状态机的
// kunShouldAutoLoad 判断: 请求在途、失败之后 (#23)、取完了都不发, 页码只在落地后推进 (P28-01)。
// IntersectionObserver 只在越过阈值时回调: 新的一页落地、把哨兵推出视口的那一刻它还没量过,
// 若拿上一次的「可见」当真, 就会接着多取一页 (私聊历史因此连取两页, 锚定也按错的起点回跳)。
// 所以每次落地之后重新 observe, 让它按落地后的布局补报一次; 哨兵仍可见就接着加载 (短页收敛, chat-history-22)
export const useKunInfiniteList = <T, Q extends KunListQuery<Q>>(
  options: KunListHookOptions<T, Q>
) => {
  const { state, dispatch, enabled, list } = useKunListCore(options)
  // 哨兵可以条件渲染: 回调 ref 只记下元素, 观察放在 passive effect 里, 与宿主的挂载滚动
  // (私聊滚到底部) 同一批执行之后才开始观察, 首次回调不会按滚动之前的位置误报可见
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const requestNextPage = useEffectEvent(() => {
    if (enabled) {
      dispatch({ type: 'loadMore' })
    }
  })

  useEffect(() => {
    if (!sentinel) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        // 一次回调可能攒了多条记录, 最后一条才是当前状态
        if (entries[entries.length - 1].isIntersecting) {
          requestNextPage()
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(sentinel)
    observerRef.current = observer
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [sentinel])

  useEffect(() => {
    const observer = observerRef.current
    if (!observer || !sentinel) {
      return
    }
    observer.unobserve(sentinel)
    observer.observe(sentinel)
  }, [state.items, state.status, sentinel])

  return {
    ...list,
    hasMore: state.hasMore,
    loadedPage: state.loadedPage,
    sentinelRef: setSentinel
  }
}
