import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { patchRatingCreateSchema } from '~/validations/patch'
import { recomputePatchRatingStat } from './stat'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import {
  enqueueTextModeration,
  planTextModeration
} from '~/server/moderation/submit'
import { ratingSubject } from '~/server/moderation/subject'
import type { KunPatchRating } from '~/types/api/galgame'
import type { KunActor } from '~/constants/role'

export const createPatchRating = async (
  input: z.infer<typeof patchRatingCreateSchema>,
  actor: KunActor
) => {
  const { uid } = actor
  const {
    patchId,
    recommend,
    overall,
    playStatus,
    shortSummary,
    spoilerLevel
  } = input

  const exists = await prisma.patch_rating.findUnique({
    where: {
      user_id_patch_id: { user_id: uid, patch_id: patchId }
    }
  })
  if (exists) {
    return '您已经评价过该游戏'
  }

  const moderation = await planTextModeration(ratingSubject(shortSummary), {
    actor
  })
  if (typeof moderation === 'string') {
    return moderation
  }

  const data = await kunTx(
    'rating.create',
    async ({ tx }) => {
      const created = await tx.patch_rating.create({
        data: {
          patch_id: patchId,
          user_id: uid,
          recommend,
          overall,
          play_status: playStatus,
          short_summary: shortSummary,
          spoiler_level: spoilerLevel,
          status: moderation.intercept ? 1 : 0
        },
        include: {
          patch: {
            select: {
              unique_id: true
            }
          },
          user: {
            select: {
              id: true,
              name: true,
              avatar: true
            }
          }
        }
      })

      if (moderation.queue) {
        await enqueueTextModeration(tx, moderation, {
          contentId: created.id,
          patchId,
          userId: uid
        })
      }

      await recomputePatchRatingStat(patchId, tx)
      return created
    },
    {
      violations: {
        // 上方 exists 预检在事务外, 并发双击 / 多标签页会双双通过预检, 靠唯一索引兜底.
        // 该事务内只有 patch_rating 带唯一约束 (moderation_task 零 @@unique), P2002 必为
        // 重复评价, 无需读 meta 区分字段
        P2002: '您已经评价过该游戏',
        // patch_id 外键: 预检只查 patch_rating, 补丁不存在或被并发删除时命中
        P2003: '未找到 Galgame'
      }
    }
  )

  if (typeof data === 'string') {
    return data
  }

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
    isLike: false,
    likeCount: 0,
    userId: data.user_id,
    patchId: data.patch_id,
    created: data.created,
    updated: data.updated,
    user: data.user
  } satisfies KunPatchRating
}
