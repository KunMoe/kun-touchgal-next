import { RATING_STATUS } from '~/constants/contentStatus'
import { recomputePatchRatingStats } from '~/app/api/patch/rating/stat'
import { settleOpenTasks } from '~/server/content/derivatives'
import { recordContentChanges } from '~/server/content/changes'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { RatingStatus } from '~/constants/contentStatus'
import type { OpenTasksPolicy } from '~/server/content/derivatives'
import type { KunTxContext } from '~/server/db/tx'

// 评价的状态迁移。返回锁下真正发生迁移的行 (连同迁移前的状态)。
// 锁序固定为「评价行 → 审核任务」, 与审核裁决、删除一致
export const transitionRatings = async (
  ctx: KunTxContext,
  ids: number[],
  options: {
    from: readonly RatingStatus[]
    to: RatingStatus
    // 随状态一起写的字段 (申诉通过时写回申诉的短评)
    data?: Omit<Prisma.patch_ratingUpdateManyMutationInput, 'status'>
    openTasks: OpenTasksPolicy
  }
) => {
  const { tx } = ctx
  const locked = await tx.$queryRaw<
    Array<{ id: number; patch_id: number; status: RatingStatus }>
  >`
    SELECT id, patch_id, status
    FROM patch_rating
    WHERE id = ANY(${ids}::int[])
    ORDER BY id
    FOR UPDATE`
  const moving = locked.filter((row) => options.from.includes(row.status))
  if (!moving.length) {
    return []
  }
  const movingIds = moving.map((row) => row.id)

  // 行已在锁下按 from 过滤过; where 里的 status 是双保险
  await tx.patch_rating.updateMany({
    where: { id: { in: movingIds }, status: { in: [...options.from] } },
    data: { ...options.data, status: options.to }
  })
  await settleOpenTasks(tx, 'rating', movingIds, options.openTasks)

  // 统计只算公开评价: 进出公开集的迁移才需要重算
  await recomputePatchRatingStats(
    moving
      .filter(
        (row) =>
          row.status === RATING_STATUS.public ||
          options.to === RATING_STATUS.public
      )
      .map((row) => row.patch_id),
    tx
  )

  recordContentChanges(
    ctx,
    moving.map((row) => ({
      kind: 'rating',
      patchId: row.patch_id,
      before: row.status,
      after: options.to,
      scoreChanged: false
    }))
  )
  return moving.map((row) => ({ id: row.id, from: row.status }))
}
