import * as z from 'zod'
import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { moderation_appealModel } from '~/prisma/generated/prisma/models'
import { adminHandleAppealSchema } from '~/validations/admin'
import { renderKunMarkdownForWrite } from '~/app/api/utils/render/renderKunMarkdown'
import { createMessage } from '~/app/api/utils/message'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { onCommentPublished } from '~/server/content/comment/publish'
import { recomputePatchRatingStat } from '~/app/api/patch/rating/stat'
import { recalcPatchType } from '~/app/api/patch/resource/_helper'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import {
  invalidatePatchContentCache,
  invalidatePatchContentCacheByPatchId
} from '~/app/api/patch/cache'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { prepareCommentContent } from '~/app/api/patch/comment/html'
import { queueSearchSync, enqueueSearchOutbox } from '~/server/search/sync'
import { kunTx } from '~/server/db/tx'
import {
  executeCommentRemoval,
  planCommentRemoval
} from '~/server/content/comment/remove'
import {
  executeRatingRemoval,
  planRatingRemoval
} from '~/server/content/rating/remove'
import {
  executeResourceRemoval,
  planResourceRemoval
} from '~/server/content/resource/remove'
import {
  COMMENT_STATUS,
  RATING_STATUS,
  RESOURCE_STATUS
} from '~/constants/contentStatus'
import { getAppealEditableLinkFields } from '~/utils/appealPayload'
import { APPEAL_APPROVED_LINK, APPEAL_RESULT_NOTICE } from '~/constants/appeal'
import { MODERATION_CONTENT_TYPE_MAP } from '~/constants/moderation'
import type { AppealLink, AppealPayload } from '~/types/api/appeal'

// 事务内的业务失败, 回滚后将错误消息返回给管理员
class AppealHandleError extends Error {}

// 申诉载荷提交后即锁定, 管理员改不了: 正文渲染不出来时能做的只有拒绝
const APPEAL_UNRENDERABLE =
  '申诉提交的正文无法渲染, 无法通过, 可拒绝该申诉以关闭'

// 把申诉里的链接字段写回链接行。须在资源行锁下调用 (资源编辑先锁资源行再整体重建
// 链接行)。隐藏态的资源不可编辑, 链接行自申诉提交起本不会变; 若其间资源被取消隐藏并
// 编辑过, 链接行已整体重建 (id 全变), 管理员复核的申诉内容对不上现有链接, 整体拒绝
// 而不部分套用。只写作者可改的字段 (见 getAppealEditableLinkFields), 按库中的存储类型
// 判断, 不看载荷里记的
const applyAppealLinks = async (
  tx: Prisma.TransactionClient,
  resourceId: number,
  links: AppealLink[]
) => {
  const currentLinks = await tx.patch_resource_link.findMany({
    where: { resource_id: resourceId },
    select: { id: true, storage: true }
  })
  const currentById = new Map(currentLinks.map((link) => [link.id, link]))
  const matched = links.flatMap((link) => {
    const current = currentById.get(link.id)
    return current ? [{ link, current }] : []
  })
  // 先整体核对再写: 申诉里的链接由提交时的库中行生成 (id 不重复), 条数相同且每条都
  // 找得到即两边是同一组行
  if (links.length !== currentLinks.length || matched.length !== links.length) {
    // 拒绝申诉会删除仍处于隐藏态的资源, 所以把不删资源的处理办法一并说明
    throw new AppealHandleError(
      '资源链接在申诉提交后已变更, 无法通过该申诉。如需保留该资源, 请先在下载资源管理中恢复它, 再拒绝本申诉'
    )
  }
  for (const { link, current } of matched) {
    const editable = getAppealEditableLinkFields(current.storage)
    if (editable.length === 0) {
      continue
    }
    await tx.patch_resource_link.update({
      where: { id: link.id },
      data: Object.fromEntries(editable.map((field) => [field, link[field]]))
    })
  }
}

const approveAppeal = async (
  appeal: moderation_appealModel,
  adminName: string,
  uid: number
) => {
  const type = appeal.content_type
  const contentId = appeal.content_id
  const payload = appeal.payload as AppealPayload

  // 事务外渲染评论 HTML。申诉正文由用户提交, 渲染不出来就不能写回; 提交入口已做同样的
  // 检查, 这里兜住在那之前提交的申诉
  const commentContent =
    type === 'comment' ? await prepareCommentContent(payload.text ?? '') : null
  if (typeof commentContent === 'string') {
    return APPEAL_UNRENDERABLE
  }

  // 事务外预取副作用所需的 patch_id
  let patchId: number | null = null
  // resource 申诉通过后由 recalcPatchType 返回, 供事务提交后失效 patch 内容缓存
  let resourceUniqueId: string | null = null
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
    const renderable = await renderKunMarkdownForWrite(
      'note',
      payload.note ?? ''
    )
    if (typeof renderable === 'string') {
      return APPEAL_UNRENDERABLE
    }
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
      // commentContent 非空即 type === 'comment'
      if (commentContent !== null) {
        const updated = await tx.patch_comment.updateMany({
          where: { id: contentId, status: 2 },
          data: {
            ...commentContent,
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
        if (updated.count > 0 && payload.modelName !== undefined) {
          // 模型型号只属于 AI 翻译补丁, 其余类型落库恒为空串: 以库中的类型为条件写,
          // 不看载荷。资源行已被上面的条件写锁住
          await tx.patch_resource.updateMany({
            where: { id: contentId, type: { has: 'ai' } },
            data: { model_name: payload.modelName }
          })
        }
        if (updated.count > 0 && payload.links) {
          await applyAppealLinks(tx, contentId, payload.links)
        }
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
          link: APPEAL_APPROVED_LINK,
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
  if (type === 'comment' && patchId !== null) {
    await invalidatePatchCommentCache(patchId)
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
  // 缓存先、通知后: 创建时被拦截而没发出的通知, 在评论恢复公开后补发
  if (type === 'comment') {
    await onCommentPublished(contentId)
  }

  return {}
}

const rejectAppeal = async (
  appeal: moderation_appealModel,
  adminName: string,
  uid: number
) => {
  const type = appeal.content_type
  const contentId = appeal.content_id

  // 认领 + 守卫删除 + 通知 + 审计同事务原子提交:
  //   - 删除命令在行锁下判定「仍是隐藏态」才删: 并发的恢复 (申诉通过 / 管理员取消
  //     隐藏) 要么先提交使守卫不通过, 要么被行锁挡到本事务之后 —— 不会误删已恢复的内容 (R1)
  //   - 通知与审计随删除同事务, 失败整体回滚, 不留下「已删已拒但无通知 / 无审计」(R3)
  //   - 失败整体回滚自动还原认领, 不会留下孤儿 pending 申诉 (R2)
  // 守卫没过时分两种: 内容已被恢复 (仍存在 → 保留, 它的通知、任务、申诉、举报都不
  // 动), 或已被别处删除 (不存在 → 已达到拒绝的目的)。
  // 删除的清理、出箱与缓存失效都在命令里, 这里不再有提交后的分支
  const outcome = await kunTx(
    'admin.appeal.reject',
    async (ctx) => {
      const { tx } = ctx
      const claim = await tx.moderation_appeal.updateMany({
        where: { id: appeal.id, status: 'pending' },
        data: { status: 'rejected', handled_by: uid }
      })
      if (claim.count === 0) {
        ctx.fail('该申诉已被处理, 请刷新后重试')
      }

      let didDelete = false
      let skipped: Array<{ reason: string }>
      if (type === 'comment') {
        const plan = await planCommentRemoval(ctx, [contentId], {
          statusIn: [COMMENT_STATUS.hidden]
        })
        if (plan.roots.length) {
          await executeCommentRemoval(ctx, plan, { orphanReports: 'inline' })
          didDelete = true
        }
        skipped = plan.skipped
      } else if (type === 'rating') {
        // 隐藏评价不计入统计: 守卫只放行隐藏态, 命令不重算、也不锁 patch
        const plan = await planRatingRemoval(ctx, [contentId], {
          statusIn: [RATING_STATUS.hidden]
        })
        if (plan.rows.length) {
          await executeRatingRemoval(ctx, plan, { orphanReports: 'inline' })
          didDelete = true
        }
        skipped = plan.skipped
      } else {
        const plan = await planResourceRemoval(ctx, [contentId], {
          guard: { statusIn: [RESOURCE_STATUS.hidden] },
          refundPublishReward: false
        })
        if (plan.rows.length) {
          await executeResourceRemoval(ctx, plan)
          didDelete = true
        }
        skipped = plan.skipped
      }
      const contentDeleted =
        didDelete || skipped.some((item) => item.reason === 'gone')

      await createMessage(
        {
          type: 'system',
          content: contentDeleted
            ? APPEAL_RESULT_NOTICE.rejected(MODERATION_CONTENT_TYPE_MAP[type])
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

      return {}
    },
    { retry: 2 }
  )
  if (typeof outcome === 'string') {
    return outcome
  }

  await invalidateUnread(appeal.user_id).catch(() => undefined)

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
