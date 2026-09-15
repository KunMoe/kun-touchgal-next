import { z } from 'zod'
import { prisma } from '~/prisma/index'
import { recomputePatchRatingStat } from './stat'
import { invalidatePatchContentCacheByPatchId } from '~/app/api/patch/cache'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'

const ratingIdSchema = z.object({
  ratingId: z.coerce.number({ message: 'ID 不正确' }).min(1).max(9999999)
})

export const deletePatchRating = async (
  input: z.infer<typeof ratingIdSchema>,
  uid: number,
  userRole: number
) => {
  const rating = await prisma.patch_rating.findUnique({
    where: { id: input.ratingId }
  })
  // 隐藏 (status=2) 的评价仅后台可管理, 前端与不存在等同
  if (!rating || rating.status === 2) {
    return '评价不存在'
  }

  if (rating.user_id !== uid && userRole < 3) {
    return '您没有权限删除该评价'
  }
  // 待审核 (status=1) 的评价禁止作者删除; 管理员可删
  if (userRole < 3 && rating.status === 1) {
    return '该评价正在审核中, 暂时无法删除'
  }

  await prisma.$transaction(async (tx) => {
    await tx.patch_rating.delete({ where: { id: input.ratingId } })
    await deletePendingModerationTasks('rating', input.ratingId, tx)
    await deletePendingAppeals('rating', input.ratingId, tx)
    await deleteOrphanReports('rating', tx)
    await recomputePatchRatingStat(rating.patch_id, tx)
  })

  // 事务提交后失效补丁详情缓存: ratingSummary 随评分统计变化 (M-05)
  await invalidatePatchContentCacheByPatchId(rating.patch_id).catch(
    () => undefined
  )

  return {}
}
