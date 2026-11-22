import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchRatingUpdateSchema } from '~/validations/patch'
import {
  hasPendingModeration,
  planTextModeration
} from '~/server/moderation/submit'
import { ratingSubject } from '~/server/moderation/subject'
import { kunTx } from '~/server/db/tx'
import { RATING_STATUS } from '~/constants/contentStatus'
import { can } from '~/constants/permission'
import { editRating } from '~/server/content/rating/edit'
import type { RatingStatus } from '~/constants/contentStatus'
import type { ContentGuard } from '~/server/content/guard'
import type { KunPatchRating } from '~/types/api/galgame'
import type { KunActor } from '~/constants/role'

export const updatePatchRating = async (
  input: z.infer<typeof patchRatingUpdateSchema>,
  actor: KunActor
) => {
  const { uid } = actor
  const canModerate = can(actor, 'content.moderateAny')
  const {
    ratingId,
    recommend,
    overall,
    playStatus,
    shortSummary,
    spoilerLevel
  } = input

  const rating = await prisma.patch_rating.findUnique({
    where: { id: ratingId },
    select: { id: true, user_id: true, status: true, short_summary: true }
  })
  // 隐藏 (status=2) 的评价仅后台可管理, 前端与不存在等同
  if (!rating || rating.status === 2) {
    return '评价不存在'
  }
  if (rating.user_id !== uid && !canModerate) {
    return '您没有权限更新该评价'
  }
  if (
    !canModerate &&
    (await hasPendingModeration('rating', { contentId: ratingId }))
  ) {
    return '您发布的评价正在审核中, 暂时无法修改'
  }
  // 待审核 (status=1) 的评价禁止修改; hasPendingModeration 之外再兜底一层
  if (!canModerate && rating.status === 1) {
    return '您发布的评价正在审核中, 暂时无法修改'
  }

  // 编辑评价文本后必须重新送审, 防止先发正常内容再改成违规绕过审核
  const moderation = await planTextModeration(ratingSubject(shortSummary), {
    actor,
    previous: ratingSubject(rating.short_summary)
  })
  if (typeof moderation === 'string') {
    return moderation
  }

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏的
  // 评价不会被这次编辑写回待审核
  const guard: ContentGuard<RatingStatus> = !canModerate
    ? { statusIn: [RATING_STATUS.public], ownerUid: uid }
    : { statusIn: [RATING_STATUS.public, RATING_STATUS.pending] }

  const data = await kunTx('rating.update', async (ctx) => {
    const { skipped } = await editRating(ctx, ratingId, {
      guard,
      data: {
        recommend,
        overall,
        play_status: playStatus,
        short_summary: shortSummary,
        spoiler_level: spoilerLevel
      },
      moderation
    })
    if (skipped) {
      ctx.fail(
        skipped.reason === 'owner'
          ? '您没有权限更新该评价'
          : skipped.reason === 'status' &&
              skipped.status === RATING_STATUS.pending
            ? '您发布的评价正在审核中, 暂时无法修改'
            : '评价不存在'
      )
    }

    // 响应要带作者与点赞信息: 在同一事务里读回写入后的行
    return ctx.tx.patch_rating.findUniqueOrThrow({
      where: { id: ratingId },
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
  })
  if (typeof data === 'string') {
    return data
  }

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
