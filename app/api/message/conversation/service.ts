import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import {
  getConversationsSchema,
  createConversationSchema
} from '~/validations/conversation'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import type { Conversation } from '~/types/api/conversation'

export const getConversations = async (
  input: z.infer<typeof getConversationsSchema>,
  uid: number
) => {
  const { page, limit } = input
  const offset = (page - 1) * limit

  const [data, total] = await Promise.all([
    prisma.user_conversation.findMany({
      where: {
        OR: [{ user_a_id: uid }, { user_b_id: uid }]
      },
      include: {
        user_a: {
          select: { id: true, name: true, avatar: true }
        },
        user_b: {
          select: { id: true, name: true, avatar: true }
        },
        messages: {
          where: { is_deleted: false },
          orderBy: [{ created: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { content: true }
        }
      },
      orderBy: [{ last_message_time: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit
    }),
    prisma.user_conversation.count({
      where: {
        OR: [{ user_a_id: uid }, { user_b_id: uid }]
      }
    })
  ])

  const conversations: Conversation[] = data.map((conv) => ({
    id: conv.id,
    otherUser: conv.user_a_id === uid ? conv.user_b : conv.user_a,
    lastMessage: conv.messages[0]?.content || '',
    lastMessageTime: conv.last_message_time,
    unreadCount:
      conv.user_a_id === uid
        ? conv.user_a_unread_count
        : conv.user_b_unread_count
  }))

  return { conversations, total }
}

const MOEMOEPOINT_REQUIRED = 20
const MOEMOEPOINT_COST = 10

export const checkConversation = async (
  input: z.infer<typeof createConversationSchema>,
  uid: number,
  role: number
) => {
  const { targetUserId } = input

  if (targetUserId === uid) {
    return { error: '不能和自己创建会话' }
  }

  const [currentUser, targetUser] = await Promise.all([
    prisma.user.findUnique({
      where: { id: uid },
      select: { moemoepoint: true }
    }),
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, allow_private_message: true }
    })
  ])

  if (!currentUser) {
    return { error: '用户不存在' }
  }
  if (!targetUser) {
    return { error: '目标用户不存在' }
  }

  const [userAId, userBId] =
    uid < targetUserId ? [uid, targetUserId] : [targetUserId, uid]

  const conversation = await prisma.user_conversation.findUnique({
    where: {
      user_a_id_user_b_id: { user_a_id: userAId, user_b_id: userBId }
    }
  })

  if (conversation) {
    return {
      exists: true,
      conversationId: conversation.id,
      needsPayment: false,
      targetUserName: targetUser.name
    }
  }

  if (!targetUser.allow_private_message) {
    return { error: '对方已关闭私信功能' }
  }

  const isPrivileged = role > 2
  const hasEnoughPoints = currentUser.moemoepoint >= MOEMOEPOINT_REQUIRED

  if (!isPrivileged && !hasEnoughPoints) {
    return {
      error: `萌萌点不足，发起私聊需要至少 ${MOEMOEPOINT_REQUIRED} 萌萌点`
    }
  }

  return {
    exists: false,
    needsPayment: !isPrivileged,
    cost: MOEMOEPOINT_COST,
    currentPoints: currentUser.moemoepoint,
    targetUserName: targetUser.name
  }
}

export const getOrCreateConversation = async (
  input: z.infer<typeof createConversationSchema>,
  uid: number,
  role: number
) => {
  const { targetUserId } = input

  if (targetUserId === uid) {
    return '不能和自己创建会话'
  }

  const [currentUser, targetUser] = await Promise.all([
    prisma.user.findUnique({
      where: { id: uid },
      select: { moemoepoint: true }
    }),
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, allow_private_message: true }
    })
  ])

  if (!currentUser) {
    return '用户不存在'
  }
  if (!targetUser) {
    return '目标用户不存在'
  }

  const [userAId, userBId] =
    uid < targetUserId ? [uid, targetUserId] : [targetUserId, uid]

  const findConversation = () =>
    prisma.user_conversation.findUnique({
      where: {
        user_a_id_user_b_id: { user_a_id: userAId, user_b_id: userBId }
      }
    })

  // 对同一目标的两个并发请求都会通过下面那次 findUnique, 落败者撞唯一索引.
  // 扣费与 create 在同一个事务里, 落败者整条回滚不会白扣分, 这里只是把未捕获的
  // 500 收敛成字符串/正常返回. isNew 必须为 false: 本次请求没有扣费, 客户端据此
  // 决定是否弹「已消耗 N 萌萌点」
  const recoverDuplicate = async (error: unknown) => {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      throw error
    }
    const existing = await findConversation()
    if (!existing) {
      throw error
    }
    return { conversationId: existing.id, isNew: false }
  }

  const conversation = await findConversation()
  if (conversation) {
    return { conversationId: conversation.id, isNew: false }
  }

  if (!targetUser.allow_private_message) {
    return '对方已关闭私信功能'
  }

  const isPrivileged = role > 2
  if (isPrivileged) {
    try {
      const created = await prisma.user_conversation.create({
        data: { user_a_id: userAId, user_b_id: userBId }
      })
      return { conversationId: created.id, isNew: true }
    } catch (error) {
      return recoverDuplicate(error)
    }
  }

  const insufficient = `萌萌点不足，发起私聊需要至少 ${MOEMOEPOINT_REQUIRED} 萌萌点`
  if (currentUser.moemoepoint < MOEMOEPOINT_REQUIRED) {
    return insufficient
  }

  let created: { id: number } | null
  try {
    // 条件更新即 CAS: 余额守卫必须落在 WHERE 里. 上面那次读取自事务之外, 只是省一次
    // 往返的快速失败, 不是安全边界; 并发请求读到同一份快照会一起通过它, 各扣一次把
    // 余额扣成负数 (唯一索引只约束同一对用户, 对 N 个不同目标并发不设防).
    // 谓词用 REQUIRED 而非 COST, 保留「需要 20 才能开一个, 付 10」的语义.
    // 余额不足时返回 null 而非错误字符串: 回调返回字符串照样提交事务
    created = await prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: uid, moemoepoint: { gte: MOEMOEPOINT_REQUIRED } },
        data: { moemoepoint: { decrement: MOEMOEPOINT_COST } }
      })
      if (!count) {
        return null
      }

      return tx.user_conversation.create({
        data: { user_a_id: userAId, user_b_id: userBId }
      })
    })
  } catch (error) {
    return recoverDuplicate(error)
  }

  if (!created) {
    // CAS 落空不只有余额不足一种成因: 余额在 20~29 时与同目标并发, 赢家扣费后
    // 落败者 EPQ 重求值落空, 走不到 create 撞 P2002, recoverDuplicate 不可达,
    // 而此刻会话已由赢家建好, 必须回读而不是报「萌萌点不足」. isNew 为 false
    // 的理由同 recoverDuplicate: 本次请求没有扣费
    const existing = await findConversation()
    if (existing) {
      return { conversationId: existing.id, isNew: false }
    }
    return insufficient
  }

  // 失效必须留在 catch 之外: 它失败时钱已经扣了, 该以 500 逃逸, 不能被
  // recoverDuplicate 当成撞唯一索引处理
  await invalidateUserSession(uid)
  return { conversationId: created.id, isNew: true }
}
