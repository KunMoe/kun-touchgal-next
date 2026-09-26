'use client'

import { useKunNow } from '~/components/kun/KunNowProvider'
import { formatDate, formatTimeDifference } from '~/utils/time'

interface KunTimeAgoProps {
  date: number | Date | string
  // 超过该天数后不再显示相对时间，改为直接显示日期
  maxRelativeDays?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export const KunTimeAgo = ({ date, maxRelativeDays }: KunTimeAgoProps) => {
  // SSR 与水合首帧用同一个服务端 now，文本一致不会 hydration mismatch；水合后换成浏览器时间，通常文本不变。
  // 天数按毫秒差计算，不依赖所在时区的夏令时，服务端与浏览器结果一致。
  const now = useKunNow()
  const isBeyondRelativeRange =
    maxRelativeDays !== undefined &&
    Math.floor((now - new Date(date).getTime()) / DAY_MS) > maxRelativeDays

  return (
    <>
      {isBeyondRelativeRange
        ? formatDate(date, { isShowYear: true })
        : formatTimeDifference(date, now)}
    </>
  )
}
