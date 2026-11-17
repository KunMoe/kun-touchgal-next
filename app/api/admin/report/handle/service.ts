import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import {
  executeCommentRemoval,
  planCommentRemoval
} from '~/server/content/comment/remove'
import {
  executeRatingRemoval,
  planRatingRemoval
} from '~/server/content/rating/remove'
import { adminHandleReportSchema } from '~/validations/admin'
import { deleteOrphanReports } from '~/server/report/pending'
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
      rating_id: true
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
      const ratingPlan =
        deleting && targetType === 'rating'
          ? await planRatingRemoval(ctx, [targetId])
          : null

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

      // 删除、清理与缓存失效都在命令里; 孤儿举报留给下面在结案之后清
      if (commentPlan) {
        await executeCommentRemoval(ctx, commentPlan, {
          orphanReports: 'caller'
        })
      }
      if (ratingPlan) {
        await executeRatingRemoval(ctx, ratingPlan, {
          orphanReports: 'caller'
        })
      }

      // 其余举报带着 status 条件结案, 并取回真正被结案的行: 收集之后已被别的管理员
      // 处理的举报既不覆盖, 也不再给它的举报人发一条与那次处理相矛盾的通知
      const closedReports = relatedReports.length
        ? await tx.patch_report.updateManyAndReturn({
            where: { id: { in: relatedReports.map((r) => r.id) }, status: 0 },
            data: handled,
            select: { sender_id: true, reason: true }
          })
        : []

      // 收集与删除之间新提交的举报不在 relatedReports 里, 级联置空后滞留
      // pending; 待已收集的举报转为历史后, 按 NULL 目标兜底清理
      if (deleting) {
        await deleteOrphanReports(targetType, tx)
      }

      const handledReports = [report, ...closedReports]
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

  return {}
}
