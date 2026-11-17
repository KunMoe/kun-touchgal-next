import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { RATING_STATUS } from '~/constants/contentStatus'
import {
  executeRatingRemoval,
  planRatingRemoval
} from '~/server/content/rating/remove'
import type { RatingRemovalGuard } from '~/server/content/rating/remove'

const ratingIdSchema = z.object({
  ratingId: z.coerce.number({ message: 'ID 不正确' }).min(1).max(9999999)
})

export const deletePatchRating = async (
  input: z.infer<typeof ratingIdSchema>,
  uid: number,
  userRole: number
) => {
  const rating = await prisma.patch_rating.findUnique({
    where: { id: input.ratingId },
    select: { id: true, user_id: true, status: true }
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

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏或
  // 被送审的评价不会被作者删掉
  const guard: RatingRemovalGuard =
    userRole < 3
      ? { statusIn: [RATING_STATUS.public], ownerUid: uid }
      : { statusIn: [RATING_STATUS.public, RATING_STATUS.pending] }

  return kunTx('rating.delete', async (ctx) => {
    const plan = await planRatingRemoval(ctx, [rating.id], guard)
    const [skipped] = plan.skipped
    if (skipped) {
      ctx.fail(
        skipped.reason === 'owner'
          ? '您没有权限删除该评价'
          : skipped.reason === 'status' &&
              skipped.status === RATING_STATUS.pending
            ? '该评价正在审核中, 暂时无法删除'
            : '评价不存在'
      )
    }
    await executeRatingRemoval(ctx, plan, { orphanReports: 'inline' })
    return {}
  })
}
