import { differenceInSeconds } from 'date-fns'

export const formatTimeDifference = (
  pastTime: number | Date | string,
  now: number | Date = Date.now()
) => {
  const past = new Date(pastTime)
  const diffInSeconds = differenceInSeconds(now, past)

  if (diffInSeconds < 10) {
    return '数秒前'
  }

  if (diffInSeconds < 60) {
    return `${diffInSeconds} 秒前`
  } else if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60)
    return `${minutes} 分钟前`
  } else if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600)
    return `${hours} 小时前`
  } else if (diffInSeconds < 2592000) {
    const days = Math.floor(diffInSeconds / 86400)
    return `${days} 天前`
  } else if (diffInSeconds < 31536000) {
    const months = Math.floor(diffInSeconds / 2592000)
    return `${months} 个月前`
  } else {
    const years = Math.floor(diffInSeconds / 31536000)
    return `${years} 年前`
  }
}

// 站点时间展示固定为 UTC+8，避免 Node 服务器时区与浏览器本地时区不同导致 SSR/CSR 文本不一致。
const KUN_SITE_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000

const padDatePart = (value: number) => String(value).padStart(2, '0')

export const getCurrentSiteYear = () => {
  return new Date(Date.now() + KUN_SITE_TIMEZONE_OFFSET_MS).getUTCFullYear()
}

export const formatDate = (
  time: Date | string | number,
  config?: { isShowYear?: boolean; isPrecise?: boolean }
): string => {
  const date = new Date(new Date(time).getTime() + KUN_SITE_TIMEZONE_OFFSET_MS)
  const month = padDatePart(date.getUTCMonth() + 1)
  const day = padDatePart(date.getUTCDate())
  const dateText = config?.isShowYear
    ? `${date.getUTCFullYear()}-${month}-${day}`
    : `${month}-${day}`

  if (!config?.isPrecise) {
    return dateText
  }

  return `${dateText} - ${padDatePart(date.getUTCHours())}:${padDatePart(
    date.getUTCMinutes()
  )}`
}
