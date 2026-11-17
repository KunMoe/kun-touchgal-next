import { RATING_STATUS } from '~/constants/contentStatus'
import { recomputePatchRatingStat } from '~/app/api/patch/rating/stat'
import { enqueueTextModeration } from '~/server/moderation/submit'
import { recordContentChanges } from '~/server/content/changes'
import { applyContentGuard } from '~/server/content/guard'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { RatingStatus } from '~/constants/contentStatus'
import type { ContentGuard } from '~/server/content/guard'
import type { ModerationPlan } from '~/server/moderation/submit'
import type { KunTxContext } from '~/server/db/tx'

// 评价的编辑。锁行 → 行锁下判守卫 → 写入 → (需要时) 入审核队列 → 重算统计。
// 守卫在锁下判定, 理由同评论编辑: 被拦截的编辑不能把管理员刚隐藏的评价写回待审核
export const editRating = async (
  ctx: KunTxContext,
  ratingId: number,
  options: {
    // 不传即不设条件 (后台编辑)
    guard?: ContentGuard<RatingStatus>
    data: Omit<Prisma.patch_ratingUpdateManyMutationInput, 'status'>
    // 入口在事务外算好的送审计划; 被拦截的编辑把评价转为待审核
    moderation: ModerationPlan<'rating'>
  }
) => {
  const { tx } = ctx
  const locked = await tx.$queryRaw<
    Array<{
      id: number
      user_id: number
      patch_id: number
      status: RatingStatus
      overall: number
      recommend: string
    }>
  >`
    SELECT id, user_id, patch_id, status, overall, recommend
    FROM patch_rating
    WHERE id = ${ratingId}
    FOR UPDATE`
  const {
    passed: [row],
    skipped: [skipped]
  } = applyContentGuard([ratingId], locked, options.guard)
  if (!row) {
    return { row: undefined, skipped }
  }

  const { data } = options
  const after = options.moderation.intercept
    ? RATING_STATUS.pending
    : row.status
  await tx.patch_rating.updateMany({
    where: { id: ratingId },
    data: { ...data, status: after }
  })
  if (options.moderation.queue) {
    await enqueueTextModeration(tx, options.moderation, {
      contentId: ratingId,
      patchId: row.patch_id,
      userId: row.user_id
    })
  }

  // 统计只算公开评价: 编辑前不公开的评价 (待审、隐藏) 怎么改都不影响统计
  const scoreChanged =
    (data.overall !== undefined && data.overall !== row.overall) ||
    (data.recommend !== undefined && data.recommend !== row.recommend)
  if (
    row.status === RATING_STATUS.public &&
    (scoreChanged || after !== RATING_STATUS.public)
  ) {
    await recomputePatchRatingStat(row.patch_id, tx)
  }

  recordContentChanges(ctx, [
    {
      kind: 'rating',
      patchId: row.patch_id,
      before: row.status,
      after,
      scoreChanged
    }
  ])
  return { row, skipped: undefined }
}
