import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchRatingUpdateSchema } from '~/validations/patch'
import { recomputePatchRatingStat } from './stat'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import {
  MODERATION_SKIP,
  createModerationTask,
  hasPendingModeration,
  preScreenText
} from '~/server/moderation/submit'
import type { KunPatchRating } from '~/types/api/galgame'

export const updatePatchRating = async (
  input: z.infer<typeof patchRatingUpdateSchema>,
  uid: number,
  userRole: number
) => {
  const {
    ratingId,
    recommend,
    overall,
    playStatus,
    shortSummary,
    spoilerLevel
  } = input

  const rating = await prisma.patch_rating.findUnique({
    where: { id: ratingId }
  })
  // 隐藏 (status=2) 的评价仅后台可管理, 前端与不存在等同
  if (!rating || rating.status === 2) {
    return '评价不存在'
  }
  const ratingUserUid = rating.user_id
  if (rating.user_id !== uid && userRole < 3) {
    return '您没有权限更新该评价'
  }
  if (
    userRole < 3 &&
    (await hasPendingModeration('rating', { contentId: ratingId }))
  ) {
    return '您发布的评价正在审核中, 暂时无法修改'
  }
  // 待审核 (status=1) 的评价禁止修改; hasPendingModeration 之外再兜底一层
  if (userRole < 3 && rating.status === 1) {
    return '您发布的评价正在审核中, 暂时无法修改'
  }

  // 编辑评价文本后必须重新送审, 防止先发正常内容再改成违规绕过审核
  const moderation =
    rating.short_summary !== shortSummary
      ? await preScreenText(shortSummary, userRole)
      : MODERATION_SKIP

  const data = await prisma.$transaction(async (tx) => {
    const updated = await tx.patch_rating.update({
      where: { id: ratingId, user_id: ratingUserUid },
      data: {
        recommend,
        overall,
        play_status: playStatus,
        short_summary: shortSummary,
        spoiler_level: spoilerLevel,
        ...(moderation.intercept ? { status: 1 } : {})
      },
      include: {
        patch: { select: { unique_id: true } },
        user: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        _count: {
          select: { like: true }
        },
        like: {
          where: {
            user_id: uid
          }
        }
      }
    })

    if (moderation.queue) {
      await createModerationTask(
        {
          contentType: 'rating',
          contentId: ratingId,
          patchId: rating.patch_id,
          userId: ratingUserUid,
          payload: { text: shortSummary },
          dryRun: moderation.dryRun
        },
        tx
      )
    }

    await recomputePatchRatingStat(rating.patch_id, tx)
    return updated
  })

  // 事务提交后失效补丁详情缓存: ratingSummary 随评分统计变化 (M-05)
  await invalidatePatchContentCache(data.patch.unique_id).catch(() => undefined)

  return {
    id: data.id,
    uniqueId: data.patch.unique_id,
    recommend: data.recommend,
    overall: data.overall,
    playStatus: data.play_status,
    shortSummary: data.short_summary,
    spoilerLevel: data.spoiler_level,
    status: data.status,
    isLike: data.like.length > 0,
    likeCount: data._count.like,
    userId: data.user_id,
    patchId: data.patch_id,
    created: data.created,
    updated: data.updated,
    user: data.user
  } satisfies KunPatchRating
}
