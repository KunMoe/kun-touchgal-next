import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createDedupMessage } from '~/app/api/utils/message'
import { buildCommentLink } from '~/utils/patch/buildCommentLink'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'

const commentIdSchema = z.object({
  commentId: z.coerce
    .number({ message: '评论 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

// 通告锁命名空间: 见 app/api/patch/rating/like/route.ts 的说明, 三条点赞路由共用
const LIKE_LOCK_NAMESPACE = 481004

const toggleCommentLike = async (
  input: z.infer<typeof commentIdSchema>,
  uid: number
) => {
  const { commentId } = input

  const comment = await prisma.patch_comment.findUnique({
    where: { id: commentId },
    include: { patch: { select: { unique_id: true } } }
  })
  if (!comment) {
    return '未找到评论'
  }
  if (comment.user_id === uid) {
    return '您不能给自己点赞'
  }
  // 待审核 (status=1) 的评论不可点赞; 隐藏 (status=2) 的评论前端不可见, 与不存在等同
  if (comment.status === 1) {
    return '该评论正在审核中, 暂时无法点赞'
  }
  if (comment.status !== 0) {
    return '未找到评论'
  }

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
  const response = await prisma
    .$transaction(async (tx) => {
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
    })
    .catch((error: unknown) => {
      // 外键命中 = 引用行被并发删除, 取舍同 rating/like/route.ts
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        return '未找到评论'
      }
      throw error
    })

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

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, commentIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await toggleCommentLike(input, payload.uid)
  return NextResponse.json(response)
}
