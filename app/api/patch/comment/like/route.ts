import * as z from 'zod'
import { kunId } from '~/validations/primitives'
import { NextResponse } from 'next/server'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { createDedupMessage } from '~/app/api/utils/message'
import { buildCommentLink } from '~/utils/patch/buildCommentLink'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import {
  decideContentAction,
  isCommentContainerVisible
} from '~/utils/content/policy'
import type { ContentViewer } from '~/utils/content/policy'

const commentIdSchema = z.object({
  commentId: kunId('评论 ID')
})

// 通告锁命名空间: 见 app/api/patch/rating/like/route.ts 的说明, 三条点赞路由共用
const LIKE_LOCK_NAMESPACE = 481004

const toggleCommentLike = async (
  input: z.infer<typeof commentIdSchema>,
  viewer: ContentViewer
) => {
  const { uid } = viewer
  const { commentId } = input

  const found = await prisma.patch_comment.findUnique({
    where: { id: commentId },
    include: {
      patch: { select: { unique_id: true } },
      resource: { select: { status: true, user_id: true } }
    }
  })
  const decision = decideContentAction('comment', found, viewer, 'like', {
    containerVisible: isCommentContainerVisible(found?.resource, viewer)
  })
  if (!decision.ok) {
    return decision.message
  }
  const comment = decision.row

  const messageData = {
    type: 'like' as const,
    content: `赞了您的评论：${comment.content.slice(0, 107)}`,
    sender_id: uid,
    recipient_id: comment.user_id,
    link: buildCommentLink(
      comment.patch.unique_id,
      comment.id,
      comment.resource_id
    )
  }
  const legacyMessageLink = `/${comment.patch.unique_id}`

  // deleteMany + createMany(skipDuplicates) 使并发双击不会触发 P2002/P2025
  const response = await kunTx(
    'comment.like',
    async ({ tx }) => {
      // 串行化同一用户的并发 toggle, 理由与 ::int 强转的必要性见 rating/like/route.ts
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LIKE_LOCK_NAMESPACE}::int, ${uid}::int)`

      const removed = await tx.user_patch_comment_like_relation.deleteMany({
        where: {
          user_id: uid,
          comment_id: commentId
        }
      })
      const isRemoved = removed.count > 0
      if (isRemoved) {
        await tx.user_message.deleteMany({
          where: {
            type: 'like',
            sender_id: uid,
            recipient_id: comment.user_id,
            OR: [
              { link: messageData.link },
              { link: legacyMessageLink, content: messageData.content }
            ]
          }
        })
      } else {
        await tx.user_patch_comment_like_relation.createMany({
          data: {
            user_id: uid,
            comment_id: commentId
          },
          skipDuplicates: true
        })
        await createDedupMessage(messageData, tx)
      }

      await tx.user.update({
        where: { id: comment.user_id },
        data: { moemoepoint: { increment: isRemoved ? -1 : 1 } }
      })

      return !isRemoved
    },
    // 外键命中 = 引用行被并发删除, 取舍同 rating/like/route.ts
    { violations: { P2003: '未找到评论' } }
  )

  if (typeof response === 'string') {
    return response
  }

  await invalidateUserSession(comment.user_id)
  // 点赞创建通知、取消点赞删除通知, 两支都改评论作者的未读状态, 提交后失效 (L-01)
  await invalidateUnread(comment.user_id).catch(() => undefined)
  // 评论分页共享缓存内嵌 likeCount 且有 UI 消费方 (CommentLike 直接渲染计数),
  // 不失效会与读路径按 uid 叠加的 isLike 矛盾 (红心已亮但计数仍是旧值)。点赞是该缓存
  // 的高频写路径, 此处明知会压低命中率仍选一致性 (取舍同 resource/like, 与 download
  // 计数的相反裁定之别在于后者无 UI 消费方); 若日后命中率不可接受, 出路是把 likeCount
  // 移出缓存载荷改由读路径补齐, 而不是退回不失效
  await invalidatePatchCommentCache(comment.patch_id)
  return response
}

export const PUT = kunRoute.put({
  auth: 'user',
  input: commentIdSchema,
  handler: async ({ input, actor }) => {
    // 成功时是点赞后的布尔状态, kunRoute 的返回类型不收布尔, 在这里序列化
    const response = await toggleCommentLike(input, actor)
    return NextResponse.json(response)
  }
})
