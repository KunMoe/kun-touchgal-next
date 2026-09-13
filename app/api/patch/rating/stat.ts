import { Prisma } from '~/prisma/generated/prisma/client'

// 通告锁命名空间: 与 patch type 锁 (recalcPatchType) 分属不同域, 同 patch 的评分统计
// 重算按 (域, patchId) 串行
const RATING_STAT_LOCK_NAMESPACE = 481002

const recomputePatchRatingStatsLocked = async (
  patchIds: number[],
  tx: Prisma.TransactionClient
) => {
  // 批量调用按 patch ID 的固定顺序取锁, 避免重叠批次形成锁顺序反转
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      ${RATING_STAT_LOCK_NAMESPACE}::int,
      ordered.patch_id::int
    )
    FROM unnest(ARRAY[${Prisma.join(patchIds)}]::int[]) AS ordered(patch_id)
    ORDER BY patch_id
  `

  // 从仍存在的 patch 出发: 已被级联删除的 patch 自动跳过, 无评价的 patch 写入零统计
  await tx.$executeRaw`
    INSERT INTO patch_rating_stat (
      patch_id,
      avg_overall,
      count,
      rec_strong_no,
      rec_no,
      rec_neutral,
      rec_yes,
      rec_strong_yes,
      o1,
      o2,
      o3,
      o4,
      o5,
      o6,
      o7,
      o8,
      o9,
      o10,
      created,
      updated
    )
    SELECT
      p.id,
      COALESCE(AVG(r.overall), 0)::double precision,
      COUNT(r.id)::int,
      COUNT(r.id) FILTER (WHERE r.recommend = 'strong_no')::int AS rec_strong_no,
      COUNT(r.id) FILTER (WHERE r.recommend = 'no')::int AS rec_no,
      COUNT(r.id) FILTER (WHERE r.recommend = 'neutral')::int AS rec_neutral,
      COUNT(r.id) FILTER (WHERE r.recommend = 'yes')::int AS rec_yes,
      COUNT(r.id) FILTER (WHERE r.recommend = 'strong_yes')::int AS rec_strong_yes,
      COUNT(r.id) FILTER (WHERE r.overall = 1)::int AS o1,
      COUNT(r.id) FILTER (WHERE r.overall = 2)::int AS o2,
      COUNT(r.id) FILTER (WHERE r.overall = 3)::int AS o3,
      COUNT(r.id) FILTER (WHERE r.overall = 4)::int AS o4,
      COUNT(r.id) FILTER (WHERE r.overall = 5)::int AS o5,
      COUNT(r.id) FILTER (WHERE r.overall = 6)::int AS o6,
      COUNT(r.id) FILTER (WHERE r.overall = 7)::int AS o7,
      COUNT(r.id) FILTER (WHERE r.overall = 8)::int AS o8,
      COUNT(r.id) FILTER (WHERE r.overall = 9)::int AS o9,
      COUNT(r.id) FILTER (WHERE r.overall = 10)::int AS o10,
      statement_timestamp() AT TIME ZONE 'UTC',
      statement_timestamp() AT TIME ZONE 'UTC'
    FROM patch AS p
    LEFT JOIN patch_rating AS r
      ON r.patch_id = p.id AND r.status = 0
    WHERE p.id IN (${Prisma.join(patchIds)})
    GROUP BY p.id
    ON CONFLICT (patch_id) DO UPDATE SET
      avg_overall = EXCLUDED.avg_overall,
      count = EXCLUDED.count,
      rec_strong_no = EXCLUDED.rec_strong_no,
      rec_no = EXCLUDED.rec_no,
      rec_neutral = EXCLUDED.rec_neutral,
      rec_yes = EXCLUDED.rec_yes,
      rec_strong_yes = EXCLUDED.rec_strong_yes,
      o1 = EXCLUDED.o1,
      o2 = EXCLUDED.o2,
      o3 = EXCLUDED.o3,
      o4 = EXCLUDED.o4,
      o5 = EXCLUDED.o5,
      o6 = EXCLUDED.o6,
      o7 = EXCLUDED.o7,
      o8 = EXCLUDED.o8,
      o9 = EXCLUDED.o9,
      o10 = EXCLUDED.o10,
      updated = EXCLUDED.updated
  `
}

export const recomputePatchRatingStats = async (
  patchIds: number[],
  tx: Prisma.TransactionClient
) => {
  const uniquePatchIds = [...new Set(patchIds)].sort((a, b) => a - b)
  if (!uniquePatchIds.length) {
    return
  }

  return recomputePatchRatingStatsLocked(uniquePatchIds, tx)
}

export const recomputePatchRatingStat = (
  patchId: number,
  tx: Prisma.TransactionClient
) => recomputePatchRatingStats([patchId], tx)
