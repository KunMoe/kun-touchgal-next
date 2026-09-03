import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'
import {
  createDedupMessage,
  createLinkDedupMessage,
  createMessage
} from '~/app/api/utils/message'
import { createMentionMessage } from '~/app/api/utils/createMentionMessage'
import { buildCommentLink } from '~/utils/patch/buildCommentLink'
import { recomputePatchRatingStat } from '~/app/api/patch/rating/stat'
import { recalcPatchType } from '~/app/api/patch/resource/_helper'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import {
  invalidatePatchContentCache,
  invalidatePatchContentCacheByPatchId
} from '~/app/api/patch/cache'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { enqueueSearchOutbox, queueSearchSync } from '~/server/search/sync'
import { purgeCloudflareCache } from '~/app/api/utils/purgeCloudflareCache'
import { copyObject, deleteFileFromS3 } from '~/lib/s3'
import {
  MODERATION_REJECT_CODE_MAP,
  MODERATION_REJECT_NOTICE,
  MODERATION_S3_TIMEOUT_MS
} from '~/constants/moderation'
import type { ModerationContentType } from '~/constants/moderation'
import { APPEAL_CONTENT_TYPE, APPEAL_SETTINGS_LINK } from '~/constants/appeal'
import type { ModerationAvatarPayload, ModerationTextPayload } from './submit'

export interface ApplyVerdictOptions {
  task: moderation_taskModel
  approved: boolean
  // verdict m=1: 内容保持待审核, task 转人工复审, 等人工最终裁决
  manual?: boolean
  rejectCode?: string
  rejectReason?: string
  verdict?: Prisma.InputJsonValue
  model?: string
  tokensIn?: number
  tokensOut?: number
  // 'pending' for the worker; 'manual' when an admin re-judges
  fromStatus?: 'pending' | 'manual'
}

// AI failed permanently or is misconfigured: task goes to manual review,
// content stays pending - never auto-reject on provider failure
export const markTaskManual = async (taskId: number, reason: string) =>
  prisma.moderation_task.updateMany({
    where: { id: taskId, status: 'pending' },
    data: { status: 'manual', reject_reason: reason.slice(0, 500) }
  })

// 人工把转人工的任务重新丢回队列. 认领守卫同时要求 verdict 为空:
// 否则与 worker 的 m=1 回写 (verdict 非空 + status manual) 构成分钟级 TOCTOU
// 竞态——AI 拿不准转人工的任务会被重新丢回队列, 下一轮 worker 自动放行/拒绝,
// 绕过人工最终裁决
export const requeueModerationTask = async (taskId: number) =>
  prisma.moderation_task.updateMany({
    where: { id: taskId, status: 'manual', verdict: { equals: Prisma.DbNull } },
    data: {
      status: 'pending',
      retry: 0,
      next_attempt: new Date(),
      // 清掉上次处理遗留的租约, 否则未过期的租约会阻塞重新认领
      picked_at: null,
      reject_reason: ''
    }
  })

// 创建时被拦截而未发送的通知, 在评论对他人可见后补发
// (文案须与 comment/create.ts 逐字一致以保 createDedupMessage 去重命中)
export const sendDeferredCommentNotifications = async (commentId: number) => {
  const comment = await prisma.patch_comment.findUnique({
    where: { id: commentId },
    include: {
      patch: { select: { name: true, unique_id: true } },
      user: { select: { name: true } },
      parent: { select: { user_id: true, content: true } },
      resource: { select: { user_id: true } }
    }
  })
  if (!comment) {
    return
  }
  if (comment.parent && comment.parent.user_id !== comment.user_id) {
    await createDedupMessage({
      type: 'comment',
      content: `回复了您的评论：${comment.parent.content.slice(0, 107)}`,
      sender_id: comment.user_id,
      recipient_id: comment.parent.user_id,
      link: buildCommentLink(
        comment.patch.unique_id,
        comment.id,
        comment.resource_id
      )
    })
    // 自动提交后失效收件人未读缓存 (L-01); 去重命中时多一次 DEL 无害
    await invalidateUnread(comment.parent.user_id).catch(() => undefined)
  }
  // 资源的一级评论通知资源上传者 (自评自己上传的资源不通知);
  // link 维度去重: 评论编辑重审通过后 content 会变, 不能进去重键
  if (
    !comment.parent_id &&
    comment.resource_id &&
    comment.resource &&
    comment.resource.user_id !== comment.user_id
  ) {
    await createLinkDedupMessage({
      type: 'comment',
      content: `评论了您发布的资源：${comment.content.slice(0, 107)}`,
      sender_id: comment.user_id,
      recipient_id: comment.resource.user_id,
      link: buildCommentLink(
        comment.patch.unique_id,
        comment.id,
        comment.resource_id
      )
    })
    await invalidateUnread(comment.resource.user_id).catch(() => undefined)
  }
  await createMentionMessage(
    comment.patch.unique_id,
    comment.patch.name,
    comment.id,
    comment.user_id,
    comment.user.name,
    comment.content,
    comment.resource_id
  )
}

const resolveRejectReason = (rejectCode?: string, rejectReason?: string) =>
  rejectReason ||
  (rejectCode ? MODERATION_REJECT_CODE_MAP[rejectCode] : '') ||
  '包含违规内容'

// Applies a moderation verdict idempotently: the task row transition is the
// gate - if the task already left `fromStatus`, nothing happens.
// Returns false when the claim failed.
export const applyModerationVerdict = async (
  options: ApplyVerdictOptions
): Promise<boolean> => {
  const {
    task,
    approved,
    manual = false,
    rejectCode,
    rejectReason,
    verdict,
    model,
    tokensIn,
    tokensOut,
    fromStatus = 'pending'
  } = options

  const taskStatus = manual ? 'manual' : approved ? 'approved' : 'rejected'
  const reason = resolveRejectReason(rejectCode, rejectReason)

  // S3 copy is idempotent, do it before claiming so that a copy failure
  // leaves the task pending and retryable; m=1 转人工时不落地, 等人工最终裁决
  if (!task.dry_run && task.content_type === 'avatar' && approved && !manual) {
    const payload = task.payload as unknown as ModerationAvatarPayload
    await copyObject(
      payload.pendingKey,
      payload.avatarKey,
      AbortSignal.timeout(MODERATION_S3_TIMEOUT_MS)
    )
    await copyObject(
      payload.pendingMiniKey,
      payload.avatarMiniKey,
      AbortSignal.timeout(MODERATION_S3_TIMEOUT_MS)
    )
  }

  let claimed = false
  let resourcePatchId: number | null = null
  let resourceUniqueId: string | null = null
  let commentApproved = false
  let commentPatchId: number | null = null
  let commentResourceId: number | null = null
  let ratingPatchId: number | null = null

  await prisma.$transaction(async (tx) => {
    // user 级联删除先锁 user 行, 再删内容与 task; 普通删除路径则是
    // 内容行 → task. 裁决统一按 user → 内容行 → task 取锁, 避免反向等待.
    // 普通内容只需 FOR KEY SHARE 阻止 user 被删除; avatar/bio 会更新
    // user 行, 首次直接取 FOR UPDATE, 避免并发裁决从 KEY SHARE 升级时死锁.
    // dry_run 与 m=1 转人工不改内容行, 不参与排序; 内容行已被删除时锁空集,
    // 后续查询自然落空
    if (!task.dry_run && !manual) {
      if (task.content_type === 'avatar' || task.content_type === 'bio') {
        await tx.$executeRaw`SELECT id FROM "user" WHERE id = ${task.user_id} FOR UPDATE`
      } else {
        await tx.$executeRaw`SELECT id FROM "user" WHERE id = ${task.user_id} FOR KEY SHARE`

        const contentId = task.content_id ?? 0
        switch (task.content_type) {
          case 'comment':
            await tx.$executeRaw`SELECT id FROM patch_comment WHERE id = ${contentId} FOR UPDATE`
            break
          case 'rating':
            await tx.$executeRaw`SELECT id FROM patch_rating WHERE id = ${contentId} FOR UPDATE`
            break
          case 'resource':
            await tx.$executeRaw`SELECT id FROM patch_resource WHERE id = ${contentId} FOR UPDATE`
            break
        }
      }
    }

    const claim = await tx.moderation_task.updateMany({
      where: { id: task.id, status: fromStatus },
      data: {
        status: taskStatus,
        reject_code: approved ? '' : (rejectCode ?? ''),
        reject_reason: approved ? '' : reason,
        ...(verdict !== undefined ? { verdict } : {}),
        model: model ?? '',
        tokens_in: tokensIn ?? 0,
        tokens_out: tokensOut ?? 0,
        reviewed: taskStatus === 'manual' ? null : new Date()
      }
    })
    if (claim.count === 0) {
      return
    }
    claimed = true

    if (task.dry_run) {
      return
    }

    // m=1 转人工: 内容保持待审核, 不改内容也不通知, 等人工最终裁决
    if (manual) {
      return
    }

    switch (task.content_type) {
      case 'comment': {
        // 待审核 (1) 的评论: 通过转正常 (0), 拒绝转隐藏 (2)
        const updated = await tx.patch_comment.updateMany({
          where: { id: task.content_id ?? 0, status: 1 },
          data: { status: approved ? 0 : 2 }
        })
        commentApproved = approved && updated.count > 0
        // 通过转正常 (1→0) 后评论进入公开基线, 需失效共享缓存;
        // 拒绝 (1→2) 待审评论本不在基线, 无需失效
        if (commentApproved) {
          const approvedComment = await tx.patch_comment.findUnique({
            where: { id: task.content_id ?? 0 },
            select: { patch_id: true, resource_id: true }
          })
          commentPatchId = approvedComment?.patch_id ?? null
          commentResourceId = approvedComment?.resource_id ?? null
        }
        break
      }
      case 'rating': {
        const rating = await tx.patch_rating.findUnique({
          where: { id: task.content_id ?? 0 },
          select: { patch_id: true, status: true }
        })
        // 待审核 (1) 的评价: 通过转正常 (0), 拒绝转隐藏 (2)
        if (rating && rating.status === 1) {
          await tx.patch_rating.update({
            where: { id: task.content_id ?? 0 },
            data: { status: approved ? 0 : 2 }
          })
          await recomputePatchRatingStat(rating.patch_id, tx)
          ratingPatchId = rating.patch_id
        }
        break
      }
      case 'resource': {
        const resource = await tx.patch_resource.findUnique({
          where: { id: task.content_id ?? 0 },
          select: { patch_id: true, status: true }
        })
        // 待审核 (3) 的资源: 通过转正常 (0), 拒绝转隐藏 (1)
        if (resource && resource.status === 3) {
          await tx.patch_resource.update({
            where: { id: task.content_id ?? 0 },
            data: { status: approved ? 0 : 1 }
          })
          // visible resource set changed, keep aggregates consistent with
          // the admin hidden flow
          resourceUniqueId = await recalcPatchType(resource.patch_id, tx)
          // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
          await enqueueSearchOutbox(tx, resource.patch_id)
          resourcePatchId = resource.patch_id
        }
        break
      }
      case 'avatar': {
        const payload = task.payload as unknown as ModerationAvatarPayload
        if (approved) {
          await tx.user.update({
            where: { id: task.user_id },
            data: { avatar: payload.avatarLink, avatar_status: 0 }
          })
        } else {
          // pending 头像从未落地到 user.avatar (仍是旧头像), 拒绝时仅清除审核标记,
          // 保留用户原头像; pending S3 对象在提交后副作用中删除
          await tx.user.update({
            where: { id: task.user_id },
            data: { avatar_status: 0 }
          })
        }
        break
      }
      case 'bio': {
        const payload = task.payload as unknown as ModerationTextPayload
        if (approved) {
          await tx.user.update({
            where: { id: task.user_id },
            data: { bio: payload.bio ?? '', bio_status: 0 }
          })
        } else {
          // 新签名从未落地到 user.bio (仍是旧签名), 拒绝时仅清除审核标记, 保留原签名
          await tx.user.update({
            where: { id: task.user_id },
            data: { bio_status: 0 }
          })
        }
        break
      }
    }

    if (!approved) {
      const payload = task.payload as unknown as ModerationTextPayload
      const notice =
        task.content_type === 'resource'
          ? MODERATION_REJECT_NOTICE.resource(payload.name ?? '')
          : MODERATION_REJECT_NOTICE[
              task.content_type as Exclude<ModerationContentType, 'resource'>
            ]()
      await createMessage(
        {
          type: 'system',
          content: notice,
          // 可申诉类型 (被隐藏的内容) 引导用户到申诉页; avatar/bio 未被应用, 无申诉入口
          link: (APPEAL_CONTENT_TYPE as readonly string[]).includes(
            task.content_type
          )
            ? APPEAL_SETTINGS_LINK
            : '',
          recipient_id: task.user_id
        },
        tx
      )
    }
  })

  if (!claimed) {
    return false
  }
  if (task.dry_run) {
    return true
  }
  // m=1 转人工: 无内容变更与副作用, task 已置 manual, 直接返回
  if (manual) {
    return true
  }

  // post-commit side effects
  // 驳回通知在事务内写入, 提交后失效收件人未读缓存 (L-01): 事务内失效会被并发读回填旧值
  if (!approved) {
    await invalidateUnread(task.user_id).catch(() => undefined)
  }
  if (commentApproved) {
    await sendDeferredCommentNotifications(task.content_id ?? 0)
    if (commentPatchId !== null) {
      await invalidatePatchCommentCache(commentPatchId)
      // 评论通过 (1→0) 进入公开基线改 _count.comment, 失效补丁详情缓存 (M-05);
      // 资源评论不计入 _count.comment, 无需失效
      if (commentResourceId === null) {
        await invalidatePatchContentCacheByPatchId(commentPatchId).catch(
          () => undefined
        )
      }
    }
  }
  // 评价审核落定 (1→0/2) 改 ratingSummary, 失效补丁详情缓存 (M-05)
  if (ratingPatchId !== null) {
    await invalidatePatchContentCacheByPatchId(ratingPatchId).catch(
      () => undefined
    )
  }
  if (resourcePatchId !== null) {
    queueSearchSync(resourcePatchId)
    // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入
    if (resourceUniqueId !== null) {
      await invalidatePatchContentCache(resourceUniqueId).catch(() => undefined)
    }
    await invalidatePatchResourceDetailCache(resourcePatchId)
    await invalidateResourceListCache()
    // 资源离开待审核 (3→0/1): 作者 hasPendingResource 可能翻假, 失效以尽早停止 bypass
    await invalidateUserPendingResourceCache(task.user_id)
  }
  if (task.content_type === 'avatar') {
    const payload = task.payload as unknown as ModerationAvatarPayload
    const imageBedUrl = process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL
    await invalidateUserSession(task.user_id)
    // approve: 新头像已复制到正式 key, 刷新 CDN; best-effort, 抛错会跳过下方
    // pending 清理且任务已非 pending 不会重试, 使暂存对象永久泄漏
    if (approved) {
      await purgeCloudflareCache([
        `${imageBedUrl}/${payload.avatarKey}`,
        `${imageBedUrl}/${payload.avatarMiniKey}`
      ]).catch((error) =>
        console.error('Failed to purge avatar CDN cache:', error)
      )
    }
    // pending 暂存对象无论通过与否都清理; 拒绝时用户原头像与正式 key 保持不动
    await deleteFileFromS3(payload.pendingKey).catch((error) =>
      console.error('Failed to delete pending avatar:', error)
    )
    await deleteFileFromS3(payload.pendingMiniKey).catch((error) =>
      console.error('Failed to delete pending mini avatar:', error)
    )
  }
  if (task.content_type === 'bio') {
    await invalidateUserSession(task.user_id)
  }

  return true
}
