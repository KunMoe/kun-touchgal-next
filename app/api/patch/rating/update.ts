import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchRatingUpdateSchema } from '~/validations/patch'
import {
  hasPendingModeration,
  planTextModeration
} from '~/server/moderation/submit'
import { ratingSubject } from '~/server/moderation/subject'
import { kunTx } from '~/server/db/tx'
import { editRating } from '~/server/content/rating/edit'
import type { KunPatchRating } from '~/types/api/galgame'
import type { KunActor } from '~/constants/role'
import {
  contentGuard,
  contentSkipMessage,
  decideContentAction,
  pendingTaskBlocks
} from '~/utils/content/policy'

export const updatePatchRating = async (
  input: z.infer<typeof patchRatingUpdateSchema>,
  actor: KunActor
) => {
  const { uid } = actor
  const {
    ratingId,
    recommend,
    overall,
    playStatus,
    shortSummary,
    spoilerLevel
  } = input

  const found = await prisma.patch_rating.findUnique({
    where: { id: ratingId },
    select: { id: true, user_id: true, status: true, short_summary: true }
  })
  const pendingTask =
    !!found &&
    pendingTaskBlocks(actor) &&
    (await hasPendingModeration('rating', { contentId: ratingId }))
  const decision = decideContentAction('rating', found, actor, 'edit', {
    pendingTask
  })
  if (!decision.ok) {
    return decision.message
  }
  const rating = decision.row

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
  const guard = contentGuard('rating', actor)

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
      ctx.fail(contentSkipMessage('rating', 'edit', skipped))
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
