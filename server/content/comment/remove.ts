import { cleanupCommentNotifications } from '~/app/api/patch/comment/notifications'
import { deleteOrphanReports } from '~/server/report/pending'
import { purgeContentDerivatives } from '~/server/content/derivatives'
import { recordContentChanges } from '~/server/content/changes'
import { applyContentGuard } from '~/server/content/guard'
import { lockPatchRows } from '~/server/content/patchLock'
import { COMMENT_STATUS } from '~/constants/contentStatus'
import type { CommentStatus } from '~/constants/contentStatus'
import type { ContentGuard, SkippedContent } from '~/server/content/guard'
import type { Prisma } from '~/prisma/generated/prisma/client'
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
  // 根与它们的整棵回复子树, 全部在行锁下读到: parent_id 外键是 ON DELETE CASCADE,
  // 删根会带走这些行
  subtree: Array<Pick<CommentRow, 'id' | 'patch_id' | 'resource_id' | 'status'>>
}

// 收集根的整棵回复子树并升序锁住其中每一行。UNION 去重: 同一批里一个根是另一个根的
// 后代时, 子树只算一次。后代的 id 恒大于祖先, 升序加锁与先锁根的顺序不冲突
const lockSubtree = (tx: Prisma.TransactionClient, rootIds: number[]) =>
  tx.$queryRaw<CommentRemovalPlan['subtree']>`
    WITH RECURSIVE subtree AS (
      SELECT id
      FROM patch_comment
      WHERE id = ANY(${rootIds}::int[])
      UNION
      SELECT pc.id
      FROM patch_comment pc
      INNER JOIN subtree s ON pc.parent_id = s.id
    )
    SELECT pc.id, pc.patch_id, pc.resource_id, pc.status
    FROM patch_comment pc
    WHERE pc.id IN (SELECT id FROM subtree)
    ORDER BY pc.id
    FOR UPDATE OF pc`

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

  // 回复也要锁住。没锁住的回复下面还能插进新回复 (插入只对父行取 FOR KEY SHARE),
  // 新回复随后被级联带走, 它的审核任务与通知却不在清理集合里。一次查询的快照看不到
  // 等锁期间才提交的新回复, 所以反复「收集并加锁」, 直到一轮下来没有新的行: 此时子树
  // 里每一行都挡着新的子回复, 集合不会再变
  const rootIdList = roots.map((row) => row.id)
  const held = new Set(rootIdList)
  let subtree = await lockSubtree(tx, rootIdList)
  while (subtree.some((row) => !held.has(row.id))) {
    for (const row of subtree) {
      held.add(row.id)
    }
    subtree = await lockSubtree(tx, rootIdList)
  }

  // 公开的补丁级评论被删时, 计数触发器会去改 patch 行 (资源评论不计数)。评论行全部
  // 锁完之后再锁 patch 行: 审核裁决是先锁评论行、再由触发器碰 patch 行
  await lockPatchRows(tx, [
    ...new Set(
      subtree
        .filter(
          (row) =>
            row.status === COMMENT_STATUS.public && row.resource_id === null
        )
        .map((row) => row.patch_id)
    )
  ])

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

  // 根与回复的状态都是行锁下读到的, 就是删除瞬间的状态
  recordContentChanges(
    ctx,
    plan.subtree.map((row) => ({
      kind: 'comment',
      id: row.id,
      patchId: row.patch_id,
      resourceId: row.resource_id,
      before: row.status,
      after: null
    }))
  )
  return { deletedIds }
}
