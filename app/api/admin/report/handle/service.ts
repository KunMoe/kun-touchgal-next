import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import {
  executeCommentRemoval,
  planCommentRemoval
} from '~/server/content/comment/remove'
import { adminHandleReportSchema } from '~/validations/admin'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'
import { recomputePatchRatingStat } from '~/app/api/patch/rating/stat'
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
      sender_id: true,
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

  const handled = {
    status: nextStatus,
    handler_id: handlerId,
    handler_reply: handlerReply,
    handled_at: new Date()
  }
  const deleting = input.action === 'delete' && targetId !== null
  const ratingPatchId =
    deleting && targetType === 'rating' ? report.patch_id : undefined

  // 两个管理员同时处理同一目标的不同举报, 会互相等对方已认领的举报行; 被数据库
  // 判为死锁的一方重放后在认领处落空
  const notifiedUids = await kunTx(
    'admin.report.handle',
    async (ctx) => {
      const { tx } = ctx
      // 删除内容时先锁内容行再碰举报行: 与删除时 ON DELETE SET NULL 的级联同序
      // (内容行 → 举报行, 见 server/report/pending.ts)
      const commentPlan =
        deleting && targetType === 'comment'
          ? await planCommentRemoval(ctx, [targetId])
          : null
      if (deleting && targetType === 'rating') {
        await tx.$queryRaw`
          SELECT id FROM patch_rating WHERE id = ${targetId} FOR UPDATE`
      }

      // 认领: 本条举报仍未处理才继续。并发处理同一条举报的另一方匹配 0 行, 整个
      // 事务回滚, 不会覆盖已写下的结案记录、重复通知或重复删除
      const claim = await tx.patch_report.updateMany({
        where: { id: report.id, status: 0 },
        data: handled
      })
      if (claim.count === 0) {
        ctx.fail('该举报已被处理')
      }

      // 同一目标的其余未处理举报一并结案。必须在删除之前收集: 删除会把
      // comment_id / rating_id 级联置空, 之后按目标查不到任何东西。删除评论还会
      // 带走整棵回复子树, 子树上的举报同样要收
      const relatedReports = targetId
        ? await tx.patch_report.findMany({
            where: {
              status: 0,
              target_type: targetType,
              ...(targetType === 'rating'
                ? { rating_id: targetId }
                : commentPlan
                  ? {
                      comment_id: {
                        in: commentPlan.subtree.map((row) => row.id)
                      }
                    }
                  : { comment_id: targetId })
            },
            select: { id: true, sender_id: true, reason: true }
          })
        : []

      if (commentPlan) {
        await executeCommentRemoval(ctx, commentPlan, {
          orphanReports: 'caller'
        })
      } else if (deleting) {
        await tx.patch_rating.deleteMany({ where: { id: targetId } })
        await deletePendingModerationTasks('rating', [targetId], tx)
        await deletePendingAppeals('rating', [targetId], tx)
      }

      if (relatedReports.length) {
        await tx.patch_report.updateMany({
          where: { id: { in: relatedReports.map((r) => r.id) }, status: 0 },
          data: handled
        })
      }

      // 收集与删除之间新提交的举报不在 relatedReports 里, 级联置空后滞留
      // pending; 待 updateMany 将已收集举报转为历史后, 按 NULL 目标兜底清理
      if (deleting) {
        await deleteOrphanReports(targetType, tx)
      }

      const handledReports = [report, ...relatedReports]
      const recipientIds = [...new Set(handledReports.map((r) => r.sender_id))]
      await tx.user_message.createMany({
        data: recipientIds.map((recipientId) => {
          const senderReport = handledReports.find(
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

      if (ratingPatchId !== undefined && ratingPatchId !== null) {
        await recomputePatchRatingStat(ratingPatchId, tx)
      }

      return recipientIds
    },
    { retry: 2 }
  )
  if (typeof notifiedUids === 'string') {
    return notifiedUids
  }

  // 提交后失效收件人未读缓存 (L-01): 事务内失效会被并发读回填旧值
  await Promise.all(
    notifiedUids.map((uid) => invalidateUnread(uid).catch(() => undefined))
  )

  // 删除评分改变 ratingSummary, 失效补丁详情缓存 (M-05)
  if (ratingPatchId !== undefined && ratingPatchId !== null) {
    await invalidatePatchContentCacheByPatchId(ratingPatchId).catch(
      () => undefined
    )
  }

  return {}
}
