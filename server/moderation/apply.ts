import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'
import { createMessage } from '~/app/api/utils/message'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { purgeCloudflareCache } from '~/app/api/utils/purgeCloudflareCache'
import { copyObject, deleteFileFromS3 } from '~/lib/s3'
import { toDependencyFailure } from '~/lib/resilience/failure'
import { kunTx } from '~/server/db/tx'
import { transitionComments } from '~/server/content/comment/transition'
import { transitionRatings } from '~/server/content/rating/transition'
import { transitionResources } from '~/server/content/resource/transition'
import {
  COMMENT_STATUS,
  RATING_STATUS,
  RESOURCE_STATUS
} from '~/constants/contentStatus'
import {
  MODERATION_REJECT_CODE_MAP,
  MODERATION_REJECT_NOTICE,
  MODERATION_S3_TIMEOUT_MS
} from '~/constants/moderation'
import type {
  ModerationContentType,
  ModerationFailureKind
} from '~/constants/moderation'
import { APPEAL_CONTENT_TYPE, APPEAL_SETTINGS_LINK } from '~/constants/appeal'
import {
  MODERATION_PAYLOAD_UNREADABLE,
  decodeModerationTask
} from './taskCodec'

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
// content stays pending - never auto-reject on provider failure.
// kind 写进 failure_kind, 管理端据此区分转人工的原因 (reject_code 留给 AI 的类别码)
export const markTaskManual = async (
  taskId: number,
  failure: { kind: ModerationFailureKind; reason: string }
) =>
  prisma.moderation_task.updateMany({
    where: { id: taskId, status: 'pending' },
    data: {
      status: 'manual',
      failure_kind: failure.kind,
      reject_reason: failure.reason.slice(0, 500)
    }
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
      // 两份失败预算与失败类别一起清零: 重排是管理员说「再从头试一遍」
      retry: 0,
      defer_count: 0,
      failure_kind: '',
      next_attempt: new Date(),
      // 清掉上次处理遗留的租约, 否则未过期的租约会阻塞重新认领
      picked_at: null,
      reject_reason: ''
    }
  })

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

  // 解不出来的载荷不挡裁决本身 (否则这条任务与用户的审核中标记永远清不掉):
  // 只有确实要用到载荷的分支才要求它可读, 其余沿用缺省值
  const body = decodeModerationTask(task)
  const avatar = body?.contentType === 'avatar' ? body.payload : null
  const text = body && body.contentType !== 'avatar' ? body : null

  // S3 copy is idempotent, do it before claiming so that a copy failure
  // leaves the task pending and retryable; m=1 转人工时不落地, 等人工最终裁决
  if (!task.dry_run && task.content_type === 'avatar' && approved && !manual) {
    if (!avatar) {
      throw new Error(MODERATION_PAYLOAD_UNREADABLE)
    }
    try {
      await copyObject(
        avatar.pendingKey,
        avatar.avatarKey,
        AbortSignal.timeout(MODERATION_S3_TIMEOUT_MS)
      )
      await copyObject(
        avatar.pendingMiniKey,
        avatar.avatarMiniKey,
        AbortSignal.timeout(MODERATION_S3_TIMEOUT_MS)
      )
    } catch (error) {
      // 存储的失败在这里说清范围 (lib/resilience/failure.ts), worker 据此决定算谁的
      throw toDependencyFailure('s3', error)
    }
  }

  // 待生效的新签名只暂存在载荷里: 读不出来就无从通过。与头像一样在认领之前拒绝执行,
  // 任务留在原状态, 否则会把用户的签名清成空串
  if (!task.dry_run && task.content_type === 'bio' && approved && !manual) {
    if (!text) {
      throw new Error(MODERATION_PAYLOAD_UNREADABLE)
    }
  }

  const outcome = await kunTx('moderation.apply', async (ctx) => {
    const { tx } = ctx
    const contentId = task.content_id ?? 0
    // user 级联删除先锁 user 行, 再删内容与 task; 普通删除与状态迁移则是
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
        // 裁决落定: 之前失败过的类别不再有意义 (否则 AI 拿不准转人工的任务会被
        // 管理端按失败类别归错类)
        failure_kind: '',
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
      return { claimed: false }
    }

    // dry_run 只做评估; m=1 转人工: 内容保持待审核, 不改内容也不通知, 等人工最终裁决
    if (task.dry_run || manual) {
      return { claimed: true }
    }

    // 三类内容都是「仍在待审核才落定」: 通过转公开, 拒绝转隐藏。内容已离开待审核
    // (被管理员改过状态或已删除) 时迁移命令什么都不做。本条任务已在上面认领, 没有别的
    // 在途任务要作废; 聚合重算、搜索入箱、缓存失效与评论的通知补发都在命令里
    switch (task.content_type) {
      case 'comment':
        await transitionComments(ctx, [contentId], {
          from: [COMMENT_STATUS.pending],
          to: approved ? COMMENT_STATUS.public : COMMENT_STATUS.hidden,
          openTasks: 'keep'
        })
        break
      case 'rating':
        await transitionRatings(ctx, [contentId], {
          from: [RATING_STATUS.pending],
          to: approved ? RATING_STATUS.public : RATING_STATUS.hidden,
          openTasks: 'keep'
        })
        break
      case 'resource':
        await transitionResources(ctx, [contentId], {
          from: [RESOURCE_STATUS.pending],
          to: approved ? RESOURCE_STATUS.public : RESOURCE_STATUS.hidden,
          openTasks: 'keep'
        })
        break
      case 'avatar': {
        if (approved) {
          // 通过分支在事务前已要求载荷可读 (S3 复制), 这里只为收窄类型
          if (!avatar) {
            throw new Error(MODERATION_PAYLOAD_UNREADABLE)
          }
          await tx.user.update({
            where: { id: task.user_id },
            data: { avatar: avatar.avatarLink, avatar_status: 0 }
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
        if (approved) {
          await tx.user.update({
            where: { id: task.user_id },
            data: { bio: text?.bio ?? '', bio_status: 0 }
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
      const notice =
        task.content_type === 'resource'
          ? MODERATION_REJECT_NOTICE.resource(text?.name ?? '')
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

    return { claimed: true }
  })

  if (typeof outcome === 'string' || !outcome.claimed) {
    return false
  }
  // dry_run 与 m=1 转人工: 无内容变更与副作用, task 已落定, 直接返回
  if (task.dry_run || manual) {
    return true
  }

  // post-commit side effects
  // 驳回通知在事务内写入, 提交后失效收件人未读缓存 (L-01): 事务内失效会被并发读回填旧值
  if (!approved) {
    await invalidateUnread(task.user_id).catch(() => undefined)
  }
  if (task.content_type === 'avatar') {
    const imageBedUrl = process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL
    await invalidateUserSession(task.user_id)
    // 载荷不可读时没有可清理的对象 key (此时只可能是拒绝分支)
    if (!avatar) {
      return true
    }
    // approve: 新头像已复制到正式 key, 刷新 CDN; best-effort, 抛错会跳过下方
    // pending 清理且任务已非 pending 不会重试, 使暂存对象永久泄漏
    if (approved) {
      await purgeCloudflareCache([
        `${imageBedUrl}/${avatar.avatarKey}`,
        `${imageBedUrl}/${avatar.avatarMiniKey}`
      ]).catch((error) =>
        console.error('Failed to purge avatar CDN cache:', error)
      )
    }
    // pending 暂存对象无论通过与否都清理; 拒绝时用户原头像与正式 key 保持不动
    await deleteFileFromS3(avatar.pendingKey).catch((error) =>
      console.error('Failed to delete pending avatar:', error)
    )
    await deleteFileFromS3(avatar.pendingMiniKey).catch((error) =>
      console.error('Failed to delete pending mini avatar:', error)
    )
  }
  if (task.content_type === 'bio') {
    await invalidateUserSession(task.user_id)
  }

  return true
}
