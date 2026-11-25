import { getKv, setKv, delKv } from '~/lib/redis'
import type { UnreadSnapshot } from '~/types/api/message'

const MESSAGE_UNREAD_CACHE_TTL_SECONDS = 30

const getMessageUnreadCacheKey = (uid: number) => `message:unread:${uid}`

export const getCachedUnread = async (
  uid: number
): Promise<UnreadSnapshot | null> => {
  const cached = await getKv(getMessageUnreadCacheKey(uid))
  if (!cached) {
    return null
  }

  try {
    const status = JSON.parse(cached) as Partial<UnreadSnapshot>
    if (
      typeof status.hasUnreadNotification !== 'boolean' ||
      typeof status.hasUnreadConversation !== 'boolean'
    ) {
      return null
    }

    return {
      hasUnreadNotification: status.hasUnreadNotification,
      hasUnreadConversation: status.hasUnreadConversation,
      // 带时刻之前写进缓存的条目算最旧: 客户端已有的任何快照都不会被它盖掉
      asOf: typeof status.asOf === 'number' ? status.asOf : 0
    }
  } catch {
    return null
  }
}

export const setCachedUnread = async (uid: number, status: UnreadSnapshot) => {
  await setKv(
    getMessageUnreadCacheKey(uid),
    JSON.stringify(status),
    MESSAGE_UNREAD_CACHE_TTL_SECONDS
  )
}

export const invalidateUnread = async (uid: number) => {
  try {
    await delKv(getMessageUnreadCacheKey(uid))
  } catch {
    // 失效失败不应阻断已读响应; 短 TTL 会在数十秒内兜底自愈
  }
}
