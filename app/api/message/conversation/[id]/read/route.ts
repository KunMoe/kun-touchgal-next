import { prisma } from '~/prisma/index'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { parseConversationId } from '~/validations/conversation'
import { getUnreadMessageStatus } from '~/app/api/message/unread/service'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { kunTx } from '~/server/db/tx'

const markConversationAsRead = async (conversationId: number, uid: number) => {
  const conversation = await prisma.user_conversation.findUnique({
    where: { id: conversationId }
  })

  if (!conversation) {
    return '会话不存在'
  }

  if (conversation.user_a_id !== uid && conversation.user_b_id !== uid) {
    return '无权访问此会话'
  }

  const isUserA = conversation.user_a_id === uid

  // 锁必须是首条: 发送方的插入+递增会排到本事务提交之后, 封死「updateMany 扑空,
  // 发送方在间隙里插入并递增, 清零把在途消息的角标抹掉」的交错. 只包事务不前置锁
  // 无效 —— READ COMMITTED 逐语句取快照, 清零照样盲写
  const failure = await kunTx('conversation.read', async ({ tx, fail }) => {
    const rows = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM user_conversation
      WHERE id = ${conversationId}
      FOR UPDATE
    `
    if (!rows.length) {
      fail('会话不存在')
    }

    await tx.user_private_message.updateMany({
      where: {
        conversation_id: conversationId,
        sender_id: isUserA ? conversation.user_b_id : conversation.user_a_id,
        status: 0
      },
      data: { status: 1 }
    })

    await tx.user_conversation.update({
      where: { id: conversationId },
      data: isUserA ? { user_a_unread_count: 0 } : { user_b_unread_count: 0 }
    })
  })

  return failure ?? {}
}

export const PUT = kunRoute.put({
  auth: 'user',
  params: ({ id }) => parseConversationId(id),
  handler: async ({ params: conversationId, actor: payload }) => {
    const readResponse = await markConversationAsRead(
      conversationId,
      payload.uid
    )
    if (typeof readResponse === 'string') {
      return readResponse
    }

    await invalidateUnread(payload.uid)
    return getUnreadMessageStatus(payload.uid)
  }
})
