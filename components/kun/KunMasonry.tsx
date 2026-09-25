'use client'

import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { cn } from '~/utils/cn'

interface BreakpointCols {
  default: number
  [maxWidth: number]: number
}

interface KunMasonryProps {
  children: React.ReactNode
  breakpointCols?: BreakpointCols
  gap?: number
  estimatedItemHeight?: number
  className?: string
}

const DEFAULT_BREAKPOINTS: BreakpointCols = {
  default: 3,
  1024: 2,
  640: 1
}

const resolveColumns = (
  breakpointCols: BreakpointCols,
  width: number
): number => {
  const breakpoints = Object.keys(breakpointCols)
    .map(Number)
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b)

  for (const bp of breakpoints) {
    if (width <= bp) {
      return breakpointCols[bp]
    }
  }
  return breakpointCols.default
}

export const KunMasonry = ({
  children,
  breakpointCols = DEFAULT_BREAKPOINTS,
  gap = 16,
  estimatedItemHeight = 280,
  className
}: KunMasonryProps) => {
  const items = useMemo(() => {
    return Children.toArray(children).filter(
      (child) => isValidElement(child) || typeof child === 'string'
    )
  }, [children])

  const rawItemKeys = useMemo(
    () =>
      items.map((child, index) => {
        if (isValidElement(child) && child.key != null) {
          return String(child.key)
        }
        return `__idx_${index}`
      }),
    [items]
  )

  // key 集合不变时复用上轮引用，使 layout / 清理 effect 跳过重算；
  // 渲染期写 ref 安全：输出只取决于 keys 内容（与 rawItemKeys 逐项相等），不依赖 ref 的跨渲染历史。
  const stableItemKeysRef = useRef<string[]>(rawItemKeys)
  const itemKeys = useMemo(() => {
    const prev = stableItemKeysRef.current
    if (
      prev.length === rawItemKeys.length &&
      prev.every((key, index) => key === rawItemKeys[index])
    ) {
      return prev
    }
    stableItemKeysRef.current = rawItemKeys
    return rawItemKeys
  }, [rawItemKeys])

  const containerRef = useRef<HTMLDivElement>(null)
  const itemElements = useRef<Map<string, HTMLDivElement>>(new Map())
  const elementKeyRef = useRef<WeakMap<HTMLDivElement, string>>(new WeakMap())
  const refCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(
    new Map()
  )
  const itemObserverRef = useRef<ResizeObserver | null>(null)
  const breakpointsRef = useRef(breakpointCols)
  breakpointsRef.current = breakpointCols

  const [containerWidth, setContainerWidth] = useState(0)
  const [columns, setColumns] = useState(() =>
    resolveColumns(breakpointCols, 0)
  )
  const [heights, setHeights] = useState<Record<string, number>>({})

  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0].contentRect.width
      // 所在的 tab 面板被隐藏 (display:none) 时宽度报 0: 保留上次布局. 否则切回时先画
      // 一帧空白, 且容器高度塌成 0 会让「加载更多」哨兵进入视口, 自动多拉一页
      if (width === 0) {
        return
      }
      setContainerWidth(width)
      setColumns(resolveColumns(breakpointsRef.current, width))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const batch: Record<string, number> = {}
      let hasUpdate = false
      for (const entry of entries) {
        const key = elementKeyRef.current.get(entry.target as HTMLDivElement)
        if (!key) {
          continue
        }
        const height = entry.contentRect.height
        if (height <= 0) {
          continue
        }
        batch[key] = height
        hasUpdate = true
      }
      if (!hasUpdate) {
        return
      }
      setHeights((prev) => {
        let next = prev
        let changed = false
        for (const key in batch) {
          if (prev[key] === batch[key]) {
            continue
          }
          if (!changed) {
            next = { ...prev }
            changed = true
          }
          next[key] = batch[key]
        }
        return changed ? next : prev
      })
    })
    itemObserverRef.current = observer
    itemElements.current.forEach((el) => observer.observe(el))
    return () => {
      observer.disconnect()
      itemObserverRef.current = null
    }
  }, [])

  useEffect(() => {
    const validKeys = new Set(itemKeys)
    setHeights((prev) => {
      let changed = false
      const next: Record<string, number> = {}
      for (const key of Object.keys(prev)) {
        if (validKeys.has(key)) {
          next[key] = prev[key]
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
    for (const key of refCallbacks.current.keys()) {
      if (!validKeys.has(key)) {
        refCallbacks.current.delete(key)
      }
    }
  }, [itemKeys])

  const getRefCallback = (key: string) => {
    let callback = refCallbacks.current.get(key)
    if (!callback) {
      callback = (el: HTMLDivElement | null) => {
        const previous = itemElements.current.get(key)
        if (previous && previous !== el) {
          itemObserverRef.current?.unobserve(previous)
          elementKeyRef.current.delete(previous)
        }
        if (el) {
          itemElements.current.set(key, el)
          elementKeyRef.current.set(el, key)
          itemObserverRef.current?.observe(el)
        } else {
          itemElements.current.delete(key)
        }
      }
      refCallbacks.current.set(key, callback)
    }
    return callback
  }

  const layout = useMemo(() => {
    const safeColumns = Math.max(1, columns)
    if (!containerWidth) {
      return {
        positions: new Map<string, { x: number; y: number }>(),
        totalHeight: 0,
        columnWidth: 0
      }
    }
    const columnWidth = (containerWidth - gap * (safeColumns - 1)) / safeColumns
    const columnHeights = new Array<number>(safeColumns).fill(0)
    const positions = new Map<string, { x: number; y: number }>()

    itemKeys.forEach((key) => {
      let shortest = 0
      for (let i = 1; i < safeColumns; i++) {
        if (columnHeights[i] < columnHeights[shortest]) {
          shortest = i
        }
      }
      const x = shortest * (columnWidth + gap)
      const y = columnHeights[shortest]
      positions.set(key, { x, y })
      const height = heights[key] ?? estimatedItemHeight
      columnHeights[shortest] += height + gap
    })

    const tallest = columnHeights.reduce((a, b) => Math.max(a, b), 0)
    const totalHeight = Math.max(0, tallest - gap)
    return { positions, totalHeight, columnWidth }
  }, [columns, containerWidth, gap, heights, itemKeys, estimatedItemHeight])

  const hasLayout = layout.columnWidth > 0

  return (
    <div
      ref={containerRef}
      className={cn('relative w-full', className)}
      style={{ height: hasLayout ? layout.totalHeight : undefined }}
    >
      {items.map((child, index) => {
        const key = itemKeys[index]
        const position = layout.positions.get(key)
        return (
          <div
            key={key}
            ref={getRefCallback(key)}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: hasLayout ? `${layout.columnWidth}px` : '100%',
              transform: position
                ? `translate3d(${position.x}px, ${position.y}px, 0)`
                : undefined,
              opacity: hasLayout && position ? 1 : 0,
              pointerEvents: hasLayout && position ? 'auto' : 'none'
            }}
          >
            {child}
          </div>
        )
      })}
    </div>
  )
}
