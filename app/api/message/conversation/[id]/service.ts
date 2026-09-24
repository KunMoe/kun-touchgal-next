import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import {
  getConversationMessagesSchema,
  sendPrivateMessageSchema,
  updatePrivateMessageSchema,
  deletePrivateMessageSchema
} from '~/validations/conversation'
import type { PrivateMessage } from '~/types/api/conversation'

const verifyConversationAccess = async (
  conversationId: number,
  uid: number
) => {
  const conversation = await prisma.user_conversation.findUnique({
    where: { id: conversationId },
    include: {
      user_a: { select: { id: true, name: true, avatar: true } },
      user_b: { select: { id: true, name: true, avatar: true } }
    }
  })

  if (!conversation) {
    return null
  }

  if (conversation.user_a_id !== uid && conversation.user_b_id !== uid) {
    return null
  }

  return conversation
}

export const getConversationMessages = async (
  conversationId: number,
  input: z.infer<typeof getConversationMessagesSchema>,
  uid: number
) => {
  const conversation = await verifyConversationAccess(conversationId, uid)
  if (!conversation) {
    return '会话不存在或无权访问'
  }

  const { page, limit } = input
  const offset = (page - 1) * limit

  const [data, total] = await Promise.all([
    prisma.user_private_message.findMany({
      where: { conversation_id: conversationId },
      include: {
        sender: {
          select: { id: true, name: true, avatar: true }
        }
      },
      orderBy: [{ created: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit
    }),
    prisma.user_private_message.count({
      where: { conversation_id: conversationId }
    })
  ])

  const messages: PrivateMessage[] = data.map((msg) => ({
    id: msg.id,
    content: msg.is_deleted ? '' : msg.content,
    status: msg.status,
    isDeleted: msg.is_deleted,
    editedAt: msg.edited_at,
    created: msg.created,
    sender: msg.sender
  }))

  const otherUser =
    conversation.user_a_id === uid ? conversation.user_b : conversation.user_a

  return { messages, total, otherUser }
}

export const sendMessage = async (
  conversationId: number,
  input: z.infer<typeof sendPrivateMessageSchema>,
  uid: number
) => {
  const conversation = await verifyConversationAccess(conversationId, uid)
  if (!conversation) {
    return '会话不存在或无权访问'
  }

  const { content } = input

  const isUserA = conversation.user_a_id === uid
  const recipientId = isUserA ? conversation.user_b_id : conversation.user_a_id

  // create 与递增必须同事务: 消息在提交前对读方不可见, 末尾的 update 持会话行锁
  // 到提交, 配合已读路由的锁前置封死「消息被标已读后递增才落地」的幻影角标交错
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.user_private_message.create({
      data: {
        conversation_id: conversationId,
        sender_id: uid,
        content
      }
    })

    await tx.user_conversation.update({
      where: { id: conversationId },
      data: {
        last_message_id: created.id,
        last_message_time: created.created,
        ...(isUserA
          ? { user_b_unread_count: { increment: 1 } }
          : { user_a_unread_count: { increment: 1 } })
      }
    })

    return created
  })

  await invalidateUnread(recipientId).catch(() => undefined)

  return {
    id: message.id,
    content: message.content,
    created: message.created
  }
}

export const updateMessage = async (
  conversationId: number,
  input: z.infer<typeof updatePrivateMessageSchema>,
  uid: number
) => {
  const conversation = await verifyConversationAccess(conversationId, uid)
  if (!conversation) {
    return '会话不存在或无权访问'
  }

  const { messageId, content } = input

  const message = await prisma.user_private_message.findUnique({
    where: { id: messageId }
  })

  if (!message) {
    return '消息不存在'
  }

  if (message.conversation_id !== conversationId) {
    return '消息不属于当前会话'
  }

  if (message.sender_id !== uid) {
    return '只能编辑自己的消息'
  }

  if (message.is_deleted) {
    return '无法编辑已删除的消息'
  }

  const updated = await prisma.user_private_message.update({
    where: { id: messageId },
    data: {
      content,
      edited_at: new Date()
    }
  })

  return {
    id: updated.id,
    content: updated.content,
    editedAt: updated.edited_at
  }
}

export const deleteMessage = async (
  conversationId: number,
  input: z.infer<typeof deletePrivateMessageSchema>,
  uid: number
) => {
  const conversation = await verifyConversationAccess(conversationId, uid)
  if (!conversation) {
    return '会话不存在或无权访问'
  }

  const { messageId } = input

  const message = await prisma.user_private_message.findUnique({
    where: { id: messageId }
  })

  if (!message) {
    return '消息不存在'
  }

  if (message.conversation_id !== conversationId) {
    return '消息不属于当前会话'
  }

  if (message.sender_id !== uid) {
    return '只能删除自己的消息'
  }

  await prisma.user_private_message.update({
    where: { id: messageId },
    data: { is_deleted: true }
  })

  return {}
}

export const deleteConversation = async (
  conversationId: number,
  uid: number
) => {
  const conversation = await verifyConversationAccess(conversationId, uid)
  if (!conversation) {
    return '会话不存在或无权访问'
  }

  await prisma.user_conversation.delete({
    where: { id: conversationId }
  })

  return {}
}
