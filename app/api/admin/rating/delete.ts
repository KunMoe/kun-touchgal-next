import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminDeleteRatingSchema } from '~/validations/admin'
import { kunTx } from '~/server/db/tx'
import {
  executeRatingRemoval,
  planRatingRemoval
} from '~/server/content/rating/remove'
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

  // 后台删除不设守卫: 隐藏、待审的评价都能删。与补丁级联删除、统计重算在锁上互等
  // 时数据库会判死锁回滚其中一方, 重放即可
  const failure = await kunTx(
    'admin.rating.delete',
    async (ctx) => {
      const plan = await planRatingRemoval(
        ctx,
        ratings.map((rating) => rating.id)
      )
      if (!plan.rows.length) {
        ctx.fail('未找到对应的评价')
      }
      await executeRatingRemoval(ctx, plan, { orphanReports: 'inline' })

      // 审计只记锁下实际删掉的评价, 不记读取之后已被别人删掉的
      const removedIds = new Set(plan.rows.map((row) => row.id))
      await ctx.tx.admin_log.create({
        data: {
          type: 'delete',
          user_id: uid,
          content: buildDeleteLogContent(
            admin.name,
            ratings.filter((rating) => removedIds.has(rating.id))
          )
        }
      })
    },
    { retry: 2 }
  )
  return failure ?? {}
}
