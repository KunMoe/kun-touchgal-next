import { prisma } from '~/prisma/index'
import {
  getCachedUnread,
  setCachedUnread
} from '~/app/api/message/unread/cache'
import { kunRecordCacheOutcome } from '~/server/cache/stats'
import type { MessageUnreadStatus } from '~/types/api/message'

export const getUnreadMessageStatus = async (
  uid: number
): Promise<MessageUnreadStatus> => {
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

  const status: MessageUnreadStatus = {
    hasUnreadNotification: !!unreadNotification,
    hasUnreadConversation: !!unreadConversation
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
