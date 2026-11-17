import { cleanupCommentNotifications } from '~/app/api/patch/comment/notifications'
import { deleteOrphanReports } from '~/server/report/pending'
import { purgeContentDerivatives } from '~/server/content/derivatives'
import { recordContentChanges } from '~/server/content/changes'
import { applyContentGuard } from '~/server/content/guard'
import { COMMENT_STATUS } from '~/constants/contentStatus'
import type { CommentStatus } from '~/constants/contentStatus'
import type { ContentGuard, SkippedContent } from '~/server/content/guard'
import type { KunTxContext } from '~/server/db/tx'

// 评论的物理删除。两段式: plan 只加锁和读取, execute 按固定顺序清理并删除。
// 入口夹在两段之间做自己的事 (认领举报、判定申诉结果), 并把 skipped 映射成自己的文案

export type CommentRemovalGuard = ContentGuard<CommentStatus>

interface CommentRow {
  id: number
  user_id: number
  patch_id: number
  resource_id: number | null
  status: CommentStatus
}

export type SkippedComment = SkippedContent<CommentStatus>

export interface CommentRemovalPlan {
  // 锁下通过守卫的根评论
  roots: CommentRow[]
  skipped: SkippedComment[]
  // 根与它们的整棵回复子树: parent_id 外键是 ON DELETE CASCADE, 删根会带走这些行。
  // 回复行没有加锁, 所以这里不带它们的状态: 读到之后还可能被审核裁决改掉
  subtree: Array<Pick<CommentRow, 'id' | 'patch_id' | 'resource_id'>>
}

export const planCommentRemoval = async (
  { tx }: KunTxContext,
  rootIds: number[],
  guard?: CommentRemovalGuard
): Promise<CommentRemovalPlan> => {
  // 升序锁根行: 与审核裁决、编辑的 FOR UPDATE 互斥, 批与批之间不会在评论行上反序。
  // 守卫在锁下判定, 所以并发的隐藏 / 送审要么已提交 (这里看到新状态), 要么排在本事务之后
  const locked = await tx.$queryRaw<CommentRow[]>`
    SELECT id, user_id, patch_id, resource_id, status
    FROM patch_comment
    WHERE id = ANY(${rootIds}::int[])
    ORDER BY id
    FOR UPDATE`
  const { passed: roots, skipped } = applyContentGuard(rootIds, locked, guard)
  if (!roots.length) {
    return { roots, skipped, subtree: [] }
  }

  // UNION 去重: 同一批里一个根是另一个根的后代时, 子树只算一次
  const subtree = await tx.$queryRaw<CommentRemovalPlan['subtree']>`
    WITH RECURSIVE subtree AS (
      SELECT id, patch_id, resource_id
      FROM patch_comment
      WHERE id = ANY(${roots.map((row) => row.id)}::int[])
      UNION
      SELECT pc.id, pc.patch_id, pc.resource_id
      FROM patch_comment pc
      INNER JOIN subtree s ON pc.parent_id = s.id
    )
    SELECT id, patch_id, resource_id FROM subtree`

  return { roots, skipped, subtree }
}

// orphanReports: 评论举报的外键是 ON DELETE SET NULL, 删除后目标为空且仍未处理的举报
// 即孤儿, 须在删除之后清理 (锁序「内容行 → 举报行」, 见 server/report/pending.ts)。
// 'caller' 只给举报处理用: 它要先把本次收集到的举报转为历史, 再清剩下的孤儿
export const executeCommentRemoval = async (
  ctx: KunTxContext,
  plan: CommentRemovalPlan,
  options: { orphanReports: 'inline' | 'caller' }
) => {
  const deletedIds = plan.subtree.map((row) => row.id)
  // 没有任何根通过守卫: 不清理、不删除。内容保留时它的通知、任务、申诉都要留着
  if (!plan.roots.length) {
    return { deletedIds }
  }
  const { tx } = ctx

  // 行删除后深链即成死链, 通知须在删除前按 link 清理
  await cleanupCommentNotifications(tx, deletedIds)
  await tx.patch_comment.deleteMany({
    where: { id: { in: plan.roots.map((row) => row.id) } }
  })
  await purgeContentDerivatives(tx, { comment: deletedIds })
  if (options.orphanReports === 'inline') {
    await deleteOrphanReports('comment', tx)
  }

  // 根的状态是行锁下读到的。被级联带走的回复没有加锁, 它的状态可能在子树查询之后
  // 才由待审变为公开 (那次裁决自己失效过缓存, 随后又被读者回填); 所以回复一律按
  // 「删除前公开」登记: 多失效一次无害, 少失效会让评论数与分页缓存陈旧到过期
  const rootStatusById = new Map(plan.roots.map((row) => [row.id, row.status]))
  recordContentChanges(
    ctx,
    plan.subtree.map((row) => ({
      kind: 'comment',
      id: row.id,
      patchId: row.patch_id,
      resourceId: row.resource_id,
      before: rootStatusById.get(row.id) ?? COMMENT_STATUS.public,
      after: null
    }))
  )
  return { deletedIds }
}
