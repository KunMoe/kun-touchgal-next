import { prisma } from '~/prisma/index'
import {
  getCachedUnread,
  setCachedUnread
} from '~/app/api/message/unread/cache'
import { kunRecordCacheOutcome } from '~/server/cache/stats'
import type { UnreadSnapshot } from '~/types/api/message'

export const getUnreadMessageStatus = async (
  uid: number
): Promise<UnreadSnapshot> => {
  const startedAt = performance.now()
  let readFailed = false
  const cached = await getCachedUnread(uid).catch(() => {
    readFailed = true
    return null
  })
  if (cached) {
    kunRecordCacheOutcome(
      'message:unread',
      'hit',
      performance.now() - startedAt
    )
    return cached
  }

  // 快照的时刻取查询开始之前, 随缓存条目一起存: 它反映的库状态不早于这个时刻。不能在返回时
  // 打戳 —— invalidateUnread 失败会被吞掉, 那时读到的陈旧缓存会显得比实时值还新
  const asOf = Date.now()
  const queryStartedAt = performance.now()
  const [unreadNotification, unreadConversation] = await Promise.all([
    prisma.user_message.findFirst({
      where: { recipient_id: uid, status: 0 },
      select: { id: true }
    }),
    prisma.user_conversation.findFirst({
      where: {
        OR: [
          { user_a_id: uid, user_a_unread_count: { gt: 0 } },
          { user_b_id: uid, user_b_unread_count: { gt: 0 } }
        ]
      },
      select: { id: true }
    })
  ])

  const sourceMs = performance.now() - queryStartedAt

  const status: UnreadSnapshot = {
    hasUnreadNotification: !!unreadNotification,
    hasUnreadConversation: !!unreadConversation,
    asOf
  }

  await setCachedUnread(uid, status).catch(() => undefined)
  kunRecordCacheOutcome(
    'message:unread',
    readFailed ? 'degraded' : 'miss',
    performance.now() - startedAt,
    sourceMs
  )
  return status
}
