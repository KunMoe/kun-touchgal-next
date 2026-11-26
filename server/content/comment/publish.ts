import { prisma } from '~/prisma/index'
import { kunLog } from '~/lib/log.server'
import { buildCommentLink } from '~/utils/patch/buildCommentLink'
import {
  buildMentionContent,
  extractMentionUserIds
} from '~/app/api/utils/createMentionMessage'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { reserveAbuseBudget } from '~/server/abuse/budget'

// 评论「变为公开」时要发的站内信, 全仓只有这一份: 回复通知、资源一级评论通知、提及通知。
// 直接发布、审核通过、申诉通过、管理员恢复都走 onCommentPublished; 评论被审核拦截时
// 不发, 等它对他人可见后再补。清理侧见 app/api/patch/comment/notifications.ts, 两边的
// link 都由 buildCommentLink 构造

export interface CommentNotificationSubject {
  id: number
  content: string
  authorId: number
  authorName: string
  patchName: string
  patchUniqueId: string
  resourceId: number | null
  // 回复的父评论; 顶层评论为 null
  parent: { authorId: number; content: string } | null
  // 所属资源的上传者; 不是资源评论时为 null
  resourceOwnerId: number | null
}

export interface CommentNotification {
  type: 'comment' | 'mention'
  content: string
  sender_id: number
  recipient_id: number
  link: string
}

// 纯函数: 一条评论公开后该通知谁、说什么。不通知评论者自己
export const planCommentNotifications = (
  subject: CommentNotificationSubject
): CommentNotification[] => {
  const link = buildCommentLink(
    subject.patchUniqueId,
    subject.id,
    subject.resourceId
  )
  const base = { sender_id: subject.authorId, link }
  const planned: CommentNotification[] = []

  if (subject.parent && subject.parent.authorId !== subject.authorId) {
    planned.push({
      ...base,
      type: 'comment',
      content: `回复了您的评论：${subject.parent.content.slice(0, 107)}`,
      recipient_id: subject.parent.authorId
    })
  }

  // 资源的一级评论通知资源上传者; 回复只通知父评论作者
  if (
    !subject.parent &&
    subject.resourceOwnerId !== null &&
    subject.resourceOwnerId !== subject.authorId
  ) {
    planned.push({
      ...base,
      type: 'comment',
      content: `评论了您发布的资源：${subject.content.slice(0, 107)}`,
      recipient_id: subject.resourceOwnerId
    })
  }

  const mentionedIds = [...new Set(extractMentionUserIds(subject.content))]
  for (const mentionedId of mentionedIds) {
    if (mentionedId === subject.authorId) {
      continue
    }
    planned.push({
      ...base,
      type: 'mention',
      content: buildMentionContent(
        subject.authorName,
        subject.patchName,
        subject.content
      ),
      recipient_id: mentionedId
    })
  }

  return planned
}

// 提交之后调用。同一条评论可能多次变为公开 (编辑后重审通过、隐藏后恢复), 所以三类通知
// 都以 (type, sender, recipient, link) 去重, 不含正文: 父评论或评论自己的正文会变,
// link 按评论 id 构造, 是稳定的。
// 提及的收件人取自正文、跨评论无界, 所以去重之后按真正新增的收件人数向评论者计费
// (notify.mention); 超出预算时这一轮的提及通知整批不发, 回复与资源通知照发
// 不向调用方抛错: 通知是可丢失的副作用, 评论已经落库, 不能因为它把请求变成 500
export const onCommentPublished = async (commentId: number) => {
  try {
    const comment = await prisma.patch_comment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        content: true,
        user_id: true,
        resource_id: true,
        patch: { select: { name: true, unique_id: true } },
        user: { select: { name: true, role: true } },
        parent: { select: { user_id: true, content: true } },
        resource: { select: { user_id: true } }
      }
    })
    if (!comment) {
      return
    }

    const planned = planCommentNotifications({
      id: comment.id,
      content: comment.content,
      authorId: comment.user_id,
      authorName: comment.user.name,
      patchName: comment.patch.name,
      patchUniqueId: comment.patch.unique_id,
      resourceId: comment.resource_id,
      parent: comment.parent
        ? { authorId: comment.parent.user_id, content: comment.parent.content }
        : null,
      resourceOwnerId: comment.resource?.user_id ?? null
    })
    if (!planned.length) {
      return
    }

    // 提及的 uid 来自正文, 可以是任意数字: 不存在的收件人会让 createMany 撞外键。
    // 回复与资源通知的收件人来自外键关系, 必然存在
    const mentionedIds = planned
      .filter((item) => item.type === 'mention')
      .map((item) => item.recipient_id)
    const [existingUsers, sent] = await Promise.all([
      mentionedIds.length
        ? prisma.user.findMany({
            where: { id: { in: mentionedIds } },
            select: { id: true }
          })
        : [],
      prisma.user_message.findMany({
        where: {
          type: { in: ['comment', 'mention'] },
          sender_id: comment.user_id,
          recipient_id: {
            in: [...new Set(planned.map((item) => item.recipient_id))]
          },
          link: planned[0].link
        },
        select: { type: true, recipient_id: true }
      })
    ])
    const existingUserIds = new Set(existingUsers.map((user) => user.id))
    const sentKeys = new Set(
      sent.map((message) => `${message.type}:${message.recipient_id}`)
    )
    let pending = planned.filter(
      (item) =>
        (item.type !== 'mention' || existingUserIds.has(item.recipient_id)) &&
        !sentKeys.has(`${item.type}:${item.recipient_id}`)
    )
    const mentionCount = pending.filter(
      (item) => item.type === 'mention'
    ).length
    if (mentionCount) {
      const denial = await reserveAbuseBudget(
        [{ policy: 'notify.mention', cost: mentionCount }],
        { uid: comment.user_id, role: comment.user.role }
      )
      if (denial) {
        kunLog('abuse.mention_dropped', {
          commentId,
          senderUid: comment.user_id,
          recipients: mentionCount,
          retryAfterSec: denial.retryAfterSec
        })
        pending = pending.filter((item) => item.type !== 'mention')
      }
    }
    if (!pending.length) {
      return
    }

    await prisma.user_message.createMany({ data: pending })
    // createMany 自动提交, 紧随其后失效收件人未读缓存即为提交后失效 (L-01)
    await Promise.all(
      [...new Set(pending.map((item) => item.recipient_id))].map((uid) =>
        invalidateUnread(uid)
      )
    )
  } catch (error) {
    kunLog('comment.notify_failed', { commentId }, error)
  }
}
