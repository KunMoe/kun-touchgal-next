import { prisma } from '~/prisma/index'
import { markdownToText } from '~/utils/markdownToText'
import { buildCommentLink } from '~/utils/patch/buildCommentLink'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import type { CreateMessageType } from '~/types/api/message'

export const extractMentionUserIds = (text: string) => {
  // 编辑器插入的提及链接指向 /user/{id}/comment, 历史内容存在 /resource 变体
  const regex = /\[@[^\]]+\]\(\/user\/(\d+)\/(?:comment|resource)\)/g
  return [...text.matchAll(regex)].map((match) => Number(match[1]))
}

export const createMentionMessage = async (
  uniqueId: string,
  patchName: string,
  commentId: number,
  senderUid: number,
  senderUsername: string,
  text: string,
  resourceId: number | null = null
) => {
  // 批内去重, 并与其他评论通知一致不通知自己
  const mentionedUserIds = [...new Set(extractMentionUserIds(text))].filter(
    (mentionUid) => mentionUid !== senderUid
  )
  if (!mentionedUserIds.length) {
    return
  }

  const link = buildCommentLink(uniqueId, commentId, resourceId)
  // 以 (type, sender, recipient, link) 为去重键, 不含 content (同 createLinkDedupMessage):
  // 评论编辑被拦截后重审通过时 apply.ts 会整批补发, content 含正文截断会变
  const notifiedMessages = await prisma.user_message.findMany({
    where: {
      type: 'mention',
      sender_id: senderUid,
      recipient_id: { in: mentionedUserIds },
      link
    },
    select: { recipient_id: true }
  })
  const notifiedUserIds = new Set(
    notifiedMessages.map((message) => message.recipient_id)
  )

  const pendingUserIds = mentionedUserIds.filter(
    (mentionUid) => !notifiedUserIds.has(mentionUid)
  )
  if (!pendingUserIds.length) {
    return
  }

  const content = `${senderUsername} 在「${patchName}」的评论区提到了您\n${markdownToText(text).slice(0, 50)}`
  const mentionMessageData: CreateMessageType[] = pendingUserIds.map(
    (mentionUid) => {
      return {
        type: 'mention',
        content,
        sender_id: senderUid,
        recipient_id: mentionUid,
        link
      }
    }
  )
  await prisma.user_message.createMany({
    data: mentionMessageData
  })
  // createMany 自动提交, 紧随其后失效被提及者未读缓存即为提交后失效 (L-01)
  await Promise.all(
    pendingUserIds.map((mentionUid) =>
      invalidateUnread(mentionUid).catch(() => undefined)
    )
  )
}
