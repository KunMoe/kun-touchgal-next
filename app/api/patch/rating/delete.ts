import * as z from 'zod'
import { kunId } from '~/validations/primitives'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import {
  executeRatingRemoval,
  planRatingRemoval
} from '~/server/content/rating/remove'
import type { KunActor } from '~/constants/role'
import {
  contentGuard,
  contentSkipMessage,
  decideContentAction
} from '~/utils/content/policy'

const ratingIdSchema = z.object({
  ratingId: kunId('评价 ID')
})

export const deletePatchRating = async (
  input: z.infer<typeof ratingIdSchema>,
  actor: KunActor
) => {
  const decision = decideContentAction(
    'rating',
    await prisma.patch_rating.findUnique({
      where: { id: input.ratingId },
      select: { id: true, user_id: true, status: true }
    }),
    actor,
    'delete'
  )
  if (!decision.ok) {
    return decision.message
  }
  const rating = decision.row

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏或
  // 被送审的评价不会被作者删掉
  const guard = contentGuard('rating', actor)

  const failure = await kunTx('rating.delete', async (ctx) => {
    const plan = await planRatingRemoval(ctx, [rating.id], guard)
    const [skipped] = plan.skipped
    if (skipped) {
      ctx.fail(contentSkipMessage('rating', 'delete', skipped))
    }
    await executeRatingRemoval(ctx, plan, { orphanReports: 'inline' })
  })
  return failure ?? {}
}
