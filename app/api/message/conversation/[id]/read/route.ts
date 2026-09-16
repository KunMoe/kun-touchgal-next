import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { parseConversationId } from '~/validations/conversation'
import { getUnreadMessageStatus } from '~/app/api/message/unread/service'
import { invalidateUnread } from '~/app/api/message/unread/cache'

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
  // 无效 —— READ COMMITTED 逐语句取快照, 清零照样盲写.
  // 锁行落空只能返回 false 由外层转错误字符串: 回调 return 字符串也会提交
  const locked = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM user_conversation
      WHERE id = ${conversationId}
      FOR UPDATE
    `
    if (!rows.length) {
      return false
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

    return true
  })

  if (!locked) {
    return '会话不存在'
  }

  return {}
}

export const PUT = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const conversationId = parseConversationId(id)
  if (typeof conversationId === 'string') {
    return NextResponse.json(conversationId)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const readResponse = await markConversationAsRead(conversationId, payload.uid)
  if (typeof readResponse === 'string') {
    return NextResponse.json(readResponse)
  }

  await invalidateUnread(payload.uid)
  const response = await getUnreadMessageStatus(payload.uid)
  return NextResponse.json(response)
}
