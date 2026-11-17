import { RATING_STATUS } from '~/constants/contentStatus'
import { recomputePatchRatingStats } from '~/app/api/patch/rating/stat'
import { deleteOrphanReports } from '~/server/report/pending'
import { purgeContentDerivatives } from '~/server/content/derivatives'
import { recordContentChanges } from '~/server/content/changes'
import { applyContentGuard } from '~/server/content/guard'
import type { RatingStatus } from '~/constants/contentStatus'
import type { ContentGuard, SkippedContent } from '~/server/content/guard'
import type { KunTxContext } from '~/server/db/tx'

// 评价的物理删除。两段式: plan 只加锁和读取, execute 按固定顺序删除并清理。
// 入口夹在两段之间做自己的事 (认领举报、判定申诉结果), 并把 skipped 映射成自己的文案

export type RatingRemovalGuard = ContentGuard<RatingStatus>

interface RatingRow {
  id: number
  user_id: number
  patch_id: number
  status: RatingStatus
}

export type SkippedRating = SkippedContent<RatingStatus>

export interface RatingRemovalPlan {
  // 锁下通过守卫的评价
  rows: RatingRow[]
  skipped: SkippedRating[]
}

export const planRatingRemoval = async (
  { tx }: KunTxContext,
  ids: number[],
  guard?: RatingRemovalGuard
): Promise<RatingRemovalPlan> => {
  // 删除公开评价要重算统计, 统计行引用 patch: 先锁涉及的 patch, 与补丁级联删除
  // (patch → 评价) 同序, 不反向等待。守卫只放行非公开评价时 (申诉驳回只删隐藏态)
  // 不改统计, 也就不碰 patch
  if (!guard || guard.statusIn.includes(RATING_STATUS.public)) {
    await tx.$executeRaw`
      SELECT id
      FROM patch
      WHERE id IN (
        SELECT patch_id FROM patch_rating WHERE id = ANY(${ids}::int[])
      )
      ORDER BY id
      FOR KEY SHARE`
  }

  // 升序锁评价行: 与审核裁决、编辑的 FOR UPDATE 互斥, 批与批之间不会在评价行上反序。
  // 守卫在锁下判定, 所以并发的隐藏 / 恢复 / 送审要么已提交 (这里看到新状态), 要么
  // 排在本事务之后
  const locked = await tx.$queryRaw<RatingRow[]>`
    SELECT id, user_id, patch_id, status
    FROM patch_rating
    WHERE id = ANY(${ids}::int[])
    ORDER BY id
    FOR UPDATE`
  const { passed: rows, skipped } = applyContentGuard(ids, locked, guard)
  return { rows, skipped }
}

// orphanReports: 评价举报的外键是 ON DELETE SET NULL, 删除后目标为空且仍未处理的举报
// 即孤儿, 须在删除之后清理 (锁序「内容行 → 举报行」, 见 server/report/pending.ts)。
// 'caller' 只给举报处理用: 它要先把本次收集到的举报转为历史, 再清剩下的孤儿
export const executeRatingRemoval = async (
  ctx: KunTxContext,
  plan: RatingRemovalPlan,
  options: { orphanReports: 'inline' | 'caller' }
) => {
  const deletedIds = plan.rows.map((row) => row.id)
  // 没有任何评价通过守卫: 不删除、不清理。内容保留时它的任务、申诉、举报都要留着
  if (!deletedIds.length) {
    return { deletedIds }
  }
  const { tx } = ctx

  await tx.patch_rating.deleteMany({ where: { id: { in: deletedIds } } })
  await purgeContentDerivatives(tx, { rating: deletedIds })
  if (options.orphanReports === 'inline') {
    await deleteOrphanReports('rating', tx)
  }
  // 统计只算公开评价: 删掉的是隐藏或待审评价时不必重算
  await recomputePatchRatingStats(
    plan.rows
      .filter((row) => row.status === RATING_STATUS.public)
      .map((row) => row.patch_id),
    tx
  )

  recordContentChanges(
    ctx,
    plan.rows.map((row) => ({
      kind: 'rating',
      patchId: row.patch_id,
      before: row.status,
      after: null,
      scoreChanged: false
    }))
  )
  return { deletedIds }
}
