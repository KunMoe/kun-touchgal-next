import * as z from 'zod'
import { isPrismaTransactionConflict, prisma } from '~/prisma/index'
import { adminDeleteRatingSchema } from '~/validations/admin'
import { Prisma } from '~/prisma/generated/prisma/client'
import { recomputePatchRatingStats } from '~/app/api/patch/rating/stat'
import { invalidatePatchContentCacheByPatchId } from '~/app/api/patch/cache'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'
import { truncateLogContent } from '~/app/api/admin/_log'

const adminDeleteRatingSummaryLimit = 10
const adminDeleteRatingPreviewLimit = 100

const buildDeleteLogContent = (
  adminName: string,
  ratings: Array<{
    id: number
    user_id: number
    patch_id: number
    recommend: string
    overall: number
    short_summary: string
  }>
) => {
  const summaries = ratings
    .slice(0, adminDeleteRatingSummaryLimit)
    .map((rating) => ({
      id: rating.id,
      userId: rating.user_id,
      patchId: rating.patch_id,
      recommend: rating.recommend,
      overall: rating.overall,
      summaryPreview: rating.short_summary.slice(
        0,
        adminDeleteRatingPreviewLimit
      )
    }))

  const suffix =
    ratings.length > summaries.length
      ? `\n其余 ${ratings.length - summaries.length} 条评价摘要已省略`
      : ''

  const content =
    ratings.length > 1
      ? `管理员 ${adminName} 批量删除了 ${ratings.length} 条评价\n评价 ID: ${ratings
          .map((rating) => rating.id)
          .join(', ')}\n评价摘要: ${JSON.stringify(summaries)}${suffix}`
      : `管理员 ${adminName} 删除了一条评价\n评价详情: ${JSON.stringify(summaries[0])}`

  return truncateLogContent(content)
}

export const deleteRating = async (
  input: z.infer<typeof adminDeleteRatingSchema>,
  uid: number
) => {
  const ratings = await prisma.patch_rating.findMany({
    where: {
      id: {
        in: input.ratingIds
      }
    }
  })
  if (!ratings.length) {
    return '未找到对应的评价'
  }

  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const ratingIds = ratings.map((rating) => rating.id)
  const patchIds = [...new Set(ratings.map((rating) => rating.patch_id))].sort(
    (a, b) => a - b
  )

  let retryCount = 0
  while (true) {
    try {
      await prisma.$transaction(async (prisma) => {
        // 先锁涉及的 patch, 避免补丁级联删除与评价删除/统计重算反向等待
        await prisma.$executeRaw`
          SELECT id
          FROM patch
          WHERE id IN (${Prisma.join(patchIds)})
          ORDER BY id
          FOR KEY SHARE
        `

        // 以事务内的当前 status 决定哪些 patch 需要重算
        const lockedRatings = await prisma.$queryRaw<
          Array<{ id: number; patch_id: number; status: number }>
        >`
          SELECT id, patch_id, status
          FROM patch_rating
          WHERE id IN (${Prisma.join(ratingIds)})
          ORDER BY id
          FOR UPDATE
        `

        await prisma.patch_rating.deleteMany({
          where: {
            id: {
              in: ratingIds
            }
          }
        })
        await deletePendingModerationTasks('rating', ratingIds, prisma)
        await deletePendingAppeals('rating', ratingIds, prisma)
        await deleteOrphanReports('rating', prisma)

        await recomputePatchRatingStats(
          lockedRatings
            .filter((rating) => rating.status === 0)
            .map((rating) => rating.patch_id),
          prisma
        )

        await prisma.admin_log.create({
          data: {
            type: 'delete',
            user_id: uid,
            content: buildDeleteLogContent(admin.name, ratings)
          }
        })
      })
      break
    } catch (error) {
      if (!isPrismaTransactionConflict(error) || retryCount >= 2) {
        throw error
      }
      retryCount++
    }
  }

  // 事务提交后失效补丁详情缓存: ratingSummary 随评分统计变化 (M-05)
  await invalidatePatchContentCacheByPatchId(patchIds).catch(() => undefined)

  return {}
}
