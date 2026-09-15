import { z } from 'zod'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { patchRatingCreateSchema } from '~/validations/patch'
import { recomputePatchRatingStat } from './stat'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { createModerationTask, preScreenText } from '~/server/moderation/submit'
import type { KunPatchRating } from '~/types/api/galgame'

export const createPatchRating = async (
  input: z.infer<typeof patchRatingCreateSchema>,
  uid: number,
  userRole: number
) => {
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

  const moderation = await preScreenText(shortSummary, userRole)

  const data = await prisma
    .$transaction(async (tx) => {
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
        await createModerationTask(
          {
            contentType: 'rating',
            contentId: created.id,
            patchId,
            userId: uid,
            payload: { text: shortSummary },
            dryRun: moderation.dryRun
          },
          tx
        )
      }

      await recomputePatchRatingStat(patchId, tx)
      return created
    })
    .catch((error: unknown) => {
      // 事务已回滚: 上方 exists 预检在事务外, 并发双击 / 多标签页会双双通过预检, 靠唯一
      // 索引兜底. 字符串在此处返回是安全的, 切勿挪进事务回调 —— 那会被当作正常结束而提交
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // 该事务内只有 patch_rating 带唯一约束 (moderation_task 零 @@unique), P2002 必为
        // 重复评价, 无需读 meta 区分字段
        if (error.code === 'P2002') {
          return '您已经评价过该游戏'
        }
        // patch_id 外键: 预检只查 patch_rating, 补丁不存在或被并发删除时命中
        if (error.code === 'P2003') {
          return '未找到 Galgame'
        }
      }
      throw error
    })

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
