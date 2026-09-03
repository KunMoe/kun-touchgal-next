import { z } from 'zod'
import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { adminHandleReportSchema } from '~/validations/admin'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'
import { collectCommentSubtreeIds } from '~/app/api/patch/comment/subtree'
import { recomputePatchRatingStat } from '~/app/api/patch/rating/stat'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { invalidatePatchContentCacheByPatchId } from '~/app/api/patch/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'

export const handleReport = async (
  input: z.infer<typeof adminHandleReportSchema>,
  handlerId: number
) => {
  const report = await prisma.patch_report.findUnique({
    where: { id: input.reportId },
    select: {
      id: true,
      status: true,
      target_type: true,
      reason: true,
      comment_id: true,
      rating_id: true,
      patch_id: true
    }
  })
  if (!report) {
    return '该举报不存在'
  }
  if (report.status !== 0) {
    return '该举报已被处理'
  }

  const targetType = report.target_type as 'comment' | 'rating'
  const targetId =
    targetType === 'comment' ? report.comment_id : report.rating_id

  const defaultReply = input.action === 'reject' ? '已驳回' : '已处理'
  const handlerReply = input.content ? input.content : defaultReply
  const nextStatus = input.action === 'reject' ? 3 : 2
  const reportResult =
    input.action === 'reject' ? '您的举报已驳回' : '您的举报已处理'
  const reportReplyLabel = input.action === 'reject' ? '驳回回复' : '处理回复'

  const relatedWhere = targetId
    ? {
        status: 0,
        target_type: targetType,
        ...(targetType === 'comment'
          ? { comment_id: targetId }
          : { rating_id: targetId })
      }
    : {
        id: report.id,
        status: 0
      }

  const ratingPatchId =
    input.action === 'delete' && targetType === 'rating' && targetId
      ? report.patch_id
      : undefined

  const notifiedUids = await prisma.$transaction(async (tx) => {
    // Collect related reports BEFORE deleting the target. Deleting the target
    // triggers ON DELETE SET NULL on patch_report.comment_id / rating_id, which
    // would cause the subsequent lookup by comment_id / rating_id to miss
    // everything, leaving the reports stuck in pending with no notifications.
    // Deleting a comment also cascades to its whole reply subtree, whose
    // pending reports would be orphaned (comment_id SET NULL, stuck in the
    // pending list forever) — collect descendant ids and handle them too.
    let pendingWhere: Prisma.patch_reportWhereInput = relatedWhere
    let commentDescendantIds: number[] = []
    if (input.action === 'delete' && targetType === 'comment' && targetId) {
      commentDescendantIds = await collectCommentSubtreeIds([targetId], tx)
      pendingWhere = {
        status: 0,
        target_type: targetType,
        comment_id: { in: commentDescendantIds }
      }
    }

    const relatedReports = await tx.patch_report.findMany({
      where: pendingWhere,
      select: { id: true, sender_id: true, reason: true }
    })

    if (input.action === 'delete' && targetId) {
      if (targetType === 'comment') {
        await tx.patch_comment.deleteMany({ where: { id: targetId } })
        await deletePendingModerationTasks('comment', commentDescendantIds, tx)
        await deletePendingAppeals('comment', commentDescendantIds, tx)
      } else {
        await tx.patch_rating.deleteMany({ where: { id: targetId } })
        await deletePendingModerationTasks('rating', [targetId], tx)
        await deletePendingAppeals('rating', [targetId], tx)
      }
    }

    const reportIds = relatedReports.map((r) => r.id)
    if (reportIds.length) {
      await tx.patch_report.updateMany({
        where: { id: { in: reportIds } },
        data: {
          status: nextStatus,
          handler_id: handlerId,
          handler_reply: handlerReply,
          handled_at: new Date()
        }
      })
    }

    // 收集与删除之间新提交的举报不在 relatedReports 里, 级联置空后滞留
    // pending; 待 updateMany 将已收集举报转为历史后, 按 NULL 目标兜底清理
    if (input.action === 'delete' && targetId) {
      await deleteOrphanReports(targetType, tx)
    }

    const recipientIds = [...new Set(relatedReports.map((r) => r.sender_id))]
    if (recipientIds.length) {
      await tx.user_message.createMany({
        data: recipientIds.map((recipientId) => {
          const senderReport = relatedReports.find(
            (r) => r.sender_id === recipientId
          )
          const reason = senderReport?.reason ?? ''
          const content = `${reportResult}\n\n举报原因：${reason.slice(0, 200)}\n${reportReplyLabel}：${handlerReply}`
          return {
            type: 'report',
            content,
            recipient_id: recipientId,
            link: '/'
          }
        })
      })
    }

    if (ratingPatchId !== undefined && ratingPatchId !== null) {
      await recomputePatchRatingStat(ratingPatchId, tx)
    }

    return recipientIds
  })

  // 提交后失效收件人未读缓存 (L-01): 事务内失效会被并发读回填旧值
  await Promise.all(
    notifiedUids.map((uid) => invalidateUnread(uid).catch(() => undefined))
  )

  if (input.action === 'delete' && targetType === 'comment' && targetId) {
    await invalidatePatchCommentCache(report.patch_id)
    // 删除公开评论改变 _count.comment, 失效补丁详情缓存 (M-05)
    await invalidatePatchContentCacheByPatchId(report.patch_id).catch(
      () => undefined
    )
  }
  // 删除评分改变 ratingSummary, 失效补丁详情缓存 (M-05)
  if (ratingPatchId !== undefined && ratingPatchId !== null) {
    await invalidatePatchContentCacheByPatchId(ratingPatchId).catch(
      () => undefined
    )
  }

  return {}
}
