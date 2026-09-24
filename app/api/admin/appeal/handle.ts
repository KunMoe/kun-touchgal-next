import * as z from 'zod'
import { prisma, isPrismaTransactionConflict } from '~/prisma/index'
import type { moderation_appealModel } from '~/prisma/generated/prisma/models'
import { adminHandleAppealSchema } from '~/validations/admin'
import {
  COMMENT_HTML_VERSION,
  markdownToHtmlComment
} from '~/app/api/utils/render/markdownToHtmlComment'
import { createMessage } from '~/app/api/utils/message'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { sendDeferredCommentNotifications } from '~/server/moderation/apply'
import { recomputePatchRatingStat } from '~/app/api/patch/rating/stat'
import {
  recalcPatchType,
  enqueueResourceLinkDeletions
} from '~/app/api/patch/resource/_helper'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import {
  invalidatePatchContentCache,
  invalidatePatchContentCacheByPatchId
} from '~/app/api/patch/cache'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { collectCommentSubtreeIds } from '~/app/api/patch/comment/subtree'
import { queueSearchSync, enqueueSearchOutbox } from '~/server/search/sync'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'
import { APPEAL_RESULT_NOTICE, APPEAL_SETTINGS_LINK } from '~/constants/appeal'
import { MODERATION_CONTENT_TYPE_MAP } from '~/constants/moderation'
import type { AppealPayload } from '~/types/api/appeal'

// 事务内的业务失败, 回滚后将错误消息返回给管理员
class AppealHandleError extends Error {}

const approveAppeal = async (
  appeal: moderation_appealModel,
  adminName: string,
  uid: number
) => {
  const type = appeal.content_type
  const contentId = appeal.content_id
  const payload = appeal.payload as AppealPayload

  // 事务外预取副作用所需的 patch_id 并渲染评论 HTML
  let patchId: number | null = null
  // resource 申诉通过后由 recalcPatchType 返回, 供事务提交后失效 patch 内容缓存
  let resourceUniqueId: string | null = null
  let contentHtml = ''
  let contentHtmlVersion = 0
  if (type === 'comment') {
    try {
      contentHtml = await markdownToHtmlComment(payload.text ?? '')
      contentHtmlVersion = COMMENT_HTML_VERSION
    } catch {
      contentHtml = ''
      contentHtmlVersion = 0
    }
    const comment = await prisma.patch_comment.findUnique({
      where: { id: contentId },
      select: { patch_id: true }
    })
    patchId = comment?.patch_id ?? null
  } else if (type === 'rating') {
    const rating = await prisma.patch_rating.findUnique({
      where: { id: contentId },
      select: { patch_id: true }
    })
    patchId = rating?.patch_id ?? null
  } else {
    const resource = await prisma.patch_resource.findUnique({
      where: { id: contentId },
      select: { patch_id: true }
    })
    patchId = resource?.patch_id ?? null
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 以申诉行状态迁移作为幂等闸门, 防止并发重复处理
      const claim = await tx.moderation_appeal.updateMany({
        where: { id: appeal.id, status: 'pending' },
        data: { status: 'approved', handled_by: uid }
      })
      if (claim.count === 0) {
        throw new AppealHandleError('该申诉已被处理, 请刷新后重试')
      }

      // 仅对仍处于隐藏状态的内容生效, 不覆盖其他管理操作的结果
      let updatedCount = 0
      if (type === 'comment') {
        const updated = await tx.patch_comment.updateMany({
          where: { id: contentId, status: 2 },
          data: {
            content: payload.text ?? '',
            content_html: contentHtml,
            content_html_version: contentHtmlVersion,
            edit: Date.now().toString(),
            status: 0
          }
        })
        updatedCount = updated.count
      } else if (type === 'rating') {
        const updated = await tx.patch_rating.updateMany({
          where: { id: contentId, status: 2 },
          data: { short_summary: payload.text ?? '', status: 0 }
        })
        updatedCount = updated.count
      } else {
        const updated = await tx.patch_resource.updateMany({
          where: { id: contentId, status: 1 },
          data: {
            name: payload.name ?? '',
            note: payload.note ?? '',
            status: 0
          }
        })
        updatedCount = updated.count
        if (updated.count > 0 && patchId !== null) {
          resourceUniqueId = await recalcPatchType(patchId, tx)
          // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
          await enqueueSearchOutbox(tx, patchId)
        }
      }
      if (updatedCount === 0) {
        throw new AppealHandleError(
          '内容已不存在或状态已变更, 无法通过, 可拒绝该申诉以关闭'
        )
      }

      if (type === 'rating' && patchId !== null) {
        await recomputePatchRatingStat(patchId, tx)
      }

      await createMessage(
        {
          type: 'system',
          content: APPEAL_RESULT_NOTICE.approved(
            MODERATION_CONTENT_TYPE_MAP[type]
          ),
          link: APPEAL_SETTINGS_LINK,
          recipient_id: appeal.user_id
        },
        tx
      )

      await tx.admin_log.create({
        data: {
          type: 'approve',
          user_id: uid,
          content: `管理员 ${adminName} 通过了申诉 (ID: ${appeal.id}, 类型: ${type}, 内容 ID: ${contentId}, 用户 ID: ${appeal.user_id}), 内容已恢复展示`
        }
      })
    })
  } catch (error) {
    if (error instanceof AppealHandleError) {
      return error.message
    }
    throw error
  }

  await invalidateUnread(appeal.user_id).catch(() => undefined)

  // 事务提交后的副作用, 与 AI 审核通过路径保持一致
  if (type === 'comment') {
    await sendDeferredCommentNotifications(contentId)
    if (patchId !== null) {
      await invalidatePatchCommentCache(patchId)
    }
  }
  if (type === 'resource') {
    if (patchId !== null) {
      queueSearchSync(patchId)
    }
    // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入
    if (resourceUniqueId !== null) {
      await invalidatePatchContentCache(resourceUniqueId).catch(() => undefined)
    }
    // 恢复至 status 0 使该资源重回公开集: 详情缓存装两个 section, 不分 section 失效
    // (事务内 updateMany 命中即资源行存在, 预取的 patchId 必非 null, 条件仅为类型收窄)
    if (patchId !== null) {
      await invalidatePatchResourceDetailCache(patchId)
    }
    await invalidateResourceListCache()
  }
  // comment 恢复 (2→0) 改 _count.comment, rating 恢复改 ratingSummary, 失效详情缓存 (M-05)
  if ((type === 'comment' || type === 'rating') && patchId !== null) {
    await invalidatePatchContentCacheByPatchId(patchId).catch(() => undefined)
  }

  return {}
}

type RejectOutcome = {
  contentDeleted: boolean
  didDelete: boolean
  affectedUniqueId: string
}

const rejectAppeal = async (
  appeal: moderation_appealModel,
  adminName: string,
  uid: number
) => {
  const type = appeal.content_type
  const contentId = appeal.content_id
  const hiddenStatus = type === 'resource' ? 1 : 2

  // 事务外预取仅取 patch_id 供提交后缓存失效; links 在事务内锁下重读 —— 快照与
  // 守卫删除之间的「恢复→重绑→再隐藏」会换 s3 对象, 快照入队漏删新对象
  let patchId: number | null = null
  if (type === 'comment') {
    const comment = await prisma.patch_comment.findUnique({
      where: { id: contentId },
      select: { patch_id: true }
    })
    patchId = comment?.patch_id ?? null
  } else if (type === 'rating') {
    const rating = await prisma.patch_rating.findUnique({
      where: { id: contentId },
      select: { patch_id: true }
    })
    patchId = rating?.patch_id ?? null
  } else {
    const resource = await prisma.patch_resource.findUnique({
      where: { id: contentId },
      select: { patch_id: true }
    })
    patchId = resource?.patch_id ?? null
  }

  // claim + guarded delete + 通知 + 审计同事务原子提交:
  //   - guarded delete 以 status 条件 + 行锁闭合"读状态→删除"窗口: 并发恢复 (approveAppeal /
  //     admin 取消隐藏) 要么先提交使删除匹配 0 行而跳过, 要么被行锁阻塞后见已删——不再误删已恢复内容 (R1)
  //   - 通知与审计随删除同事务, 失败整体回滚, 杜绝"已删已拒但无通知/无审计"的部分状态 (R3)
  //   - 失败整体回滚自动还原 claim, 无需 check-then-write 的 revertClaim, 杜绝孤儿 pending 申诉 (R2)
  const commit = async (): Promise<RejectOutcome | string> => {
    let retryCount = 0
    while (true) {
      try {
        return await prisma.$transaction(async (tx) => {
          const claim = await tx.moderation_appeal.updateMany({
            where: { id: appeal.id, status: 'pending' },
            data: { status: 'rejected', handled_by: uid }
          })
          if (claim.count === 0) {
            throw new AppealHandleError('该申诉已被处理, 请刷新后重试')
          }

          let didDelete = false
          let contentDeleted = false
          let affectedUniqueId = ''

          if (type === 'comment') {
            // 删除前收集根+后代 id, 供删除后清理其审核任务与 pending 申诉
            const subtreeIds = await collectCommentSubtreeIds([contentId], tx)
            const deleted = await tx.patch_comment.deleteMany({
              where: { id: contentId, status: hiddenStatus }
            })
            if (deleted.count > 0) {
              await deletePendingModerationTasks('comment', subtreeIds, tx)
              await deletePendingAppeals('comment', subtreeIds, tx)
              await deleteOrphanReports('comment', tx)
              didDelete = true
              contentDeleted = true
            } else {
              // 未匹配: 内容已被恢复 (仍存在→保留) 或已被并发删除 (不存在→达标)
              const still = await tx.patch_comment.findUnique({
                where: { id: contentId },
                select: { id: true }
              })
              contentDeleted = !still
            }
          } else if (type === 'rating') {
            // FOR UPDATE 锁定评分行并读事务内当前状态, 与并发恢复串行化
            const locked = await tx.$queryRaw<{ status: number }[]>`
              SELECT status FROM patch_rating WHERE id = ${contentId} FOR UPDATE
            `
            if (locked.length > 0 && locked[0].status === hiddenStatus) {
              await tx.patch_rating.deleteMany({ where: { id: contentId } })
              await deletePendingModerationTasks('rating', contentId, tx)
              await deletePendingAppeals('rating', contentId, tx)
              await deleteOrphanReports('rating', tx)
              // 隐藏态(2)评分不计入 ratingSummary, 删除无需重算统计 (对齐 adminDeleteRating)
              didDelete = true
              contentDeleted = true
            } else {
              contentDeleted = locked.length === 0
            }
          } else {
            // FOR UPDATE 锁定资源行并读事务内当前状态, 与并发恢复串行化 (对齐
            // rating 分支); links 锁下重读, 以删除瞬间的集合入队 S3 出箱.
            // 资源删除会级联删其评论 (resource_id Cascade), 评论举报外键是
            // SET NULL: 确认删除后清理级联置空的孤儿举报
            const locked = await tx.$queryRaw<{ status: number }[]>`
              SELECT status FROM patch_resource WHERE id = ${contentId} FOR UPDATE
            `
            if (
              locked.length > 0 &&
              locked[0].status === hiddenStatus &&
              patchId !== null
            ) {
              const resourcePatchId = patchId
              const lockedLinks = await tx.patch_resource_link.findMany({
                where: { resource_id: contentId }
              })
              const resourceLinksForS3 = lockedLinks
                .filter((link) => link.storage === 's3')
                .map((link) => ({
                  content: link.content,
                  patchId: resourcePatchId,
                  hash: link.hash,
                  s3Key: link.s3_key
                }))
              await tx.patch_resource.deleteMany({ where: { id: contentId } })
              await deletePendingModerationTasks('resource', contentId, tx)
              await deletePendingAppeals('resource', contentId, tx)
              await deleteOrphanReports('comment', tx)
              affectedUniqueId = await recalcPatchType(resourcePatchId, tx)
              await enqueueSearchOutbox(tx, resourcePatchId)
              await enqueueResourceLinkDeletions(tx, resourceLinksForS3)
              didDelete = true
              contentDeleted = true
            } else {
              contentDeleted = locked.length === 0
            }
          }

          await createMessage(
            {
              type: 'system',
              content: contentDeleted
                ? APPEAL_RESULT_NOTICE.rejected(
                    MODERATION_CONTENT_TYPE_MAP[type]
                  )
                : APPEAL_RESULT_NOTICE.rejectedKept(
                    MODERATION_CONTENT_TYPE_MAP[type]
                  ),
              link: '',
              recipient_id: appeal.user_id
            },
            tx
          )

          await tx.admin_log.create({
            data: {
              type: 'decline',
              user_id: uid,
              content: `管理员 ${adminName} 拒绝了申诉 (ID: ${appeal.id}, 类型: ${type}, 内容 ID: ${contentId}, 用户 ID: ${appeal.user_id})${
                didDelete
                  ? ', 内容已删除'
                  : contentDeleted
                    ? ', 内容已被其他操作删除, 未重复执行'
                    : ', 内容已被其他操作恢复, 未执行删除'
              }`
            }
          })

          return { contentDeleted, didDelete, affectedUniqueId }
        })
      } catch (error) {
        if (error instanceof AppealHandleError) {
          return error.message
        }
        if (isPrismaTransactionConflict(error) && retryCount < 2) {
          retryCount++
          continue
        }
        throw error
      }
    }
  }

  const outcome = await commit()
  if (typeof outcome === 'string') {
    return outcome
  }

  await invalidateUnread(appeal.user_id).catch(() => undefined)

  // 提交后副作用: 仅当本事务真正执行删除时触发, 与既有 adminDelete* 的提交后失效对齐;
  // best-effort, Redis 故障不回滚已提交的 DB 删除 (M-04/M-05)
  if (outcome.didDelete && patchId !== null) {
    if (type === 'comment') {
      await invalidatePatchCommentCache(patchId)
      await invalidatePatchContentCacheByPatchId(patchId).catch(() => undefined)
    } else if (type === 'rating') {
      await invalidatePatchContentCacheByPatchId(patchId).catch(() => undefined)
    } else {
      queueSearchSync(patchId)
      await invalidatePatchContentCache(outcome.affectedUniqueId).catch(
        () => undefined
      )
      // 不失效资源列表 / 详情缓存: 带守卫的删除只匹配 hiddenStatus (resource 为 1) 的行,
      // 这些行本就不在两个缓存的 status=0 集合里
      kickS3DeletionDrain()
    }
  }

  return {}
}

export const handleAppeal = async (
  input: z.infer<typeof adminHandleAppealSchema>,
  uid: number
) => {
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const appeal = await prisma.moderation_appeal.findUnique({
    where: { id: input.appealId }
  })
  if (!appeal) {
    return '未找到该申诉'
  }
  if (appeal.status !== 'pending') {
    return '该申诉已被处理'
  }

  return input.approve
    ? approveAppeal(appeal, admin.name, uid)
    : rejectAppeal(appeal, admin.name, uid)
}
