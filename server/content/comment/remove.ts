import { cleanupCommentNotifications } from '~/app/api/patch/comment/notifications'
import { deleteOrphanReports } from '~/server/report/pending'
import { purgeContentDerivatives } from '~/server/content/derivatives'
import { recordContentChanges } from '~/server/content/changes'
import type { CommentStatus } from '~/constants/contentStatus'
import type { KunTxContext } from '~/server/db/tx'

// 评论的物理删除。两段式: plan 只加锁和读取, execute 按固定顺序清理并删除。
// 入口夹在两段之间做自己的事 (认领举报、判定申诉结果), 并把 skipped 映射成自己的文案

// 入口算好的数据形状的守卫; 命令里不出现任何角色比较。不传即不设条件 (后台删除)
export interface CommentRemovalGuard {
  statusIn: readonly CommentStatus[]
  ownerUid?: number
}

interface CommentRow {
  id: number
  user_id: number
  patch_id: number
  resource_id: number | null
  status: CommentStatus
}

export type SkippedComment =
  | { id: number; reason: 'gone' }
  | { id: number; reason: 'owner' }
  | { id: number; reason: 'status'; status: CommentStatus }

export interface CommentRemovalPlan {
  // 锁下通过守卫的根评论
  roots: CommentRow[]
  skipped: SkippedComment[]
  // 根与它们的整棵回复子树: parent_id 外键是 ON DELETE CASCADE, 删根会带走这些行
  subtree: Array<Omit<CommentRow, 'user_id'>>
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
  const lockedById = new Map(locked.map((row) => [row.id, row]))

  const roots: CommentRow[] = []
  const skipped: SkippedComment[] = []
  for (const id of [...new Set(rootIds)].sort((a, b) => a - b)) {
    const row = lockedById.get(id)
    if (!row) {
      skipped.push({ id, reason: 'gone' })
    } else if (
      guard?.ownerUid !== undefined &&
      row.user_id !== guard.ownerUid
    ) {
      skipped.push({ id, reason: 'owner' })
    } else if (guard && !guard.statusIn.includes(row.status)) {
      skipped.push({ id, reason: 'status', status: row.status })
    } else {
      roots.push(row)
    }
  }
  if (!roots.length) {
    return { roots, skipped, subtree: [] }
  }

  // UNION 去重: 同一批里一个根是另一个根的后代时, 子树只算一次
  const subtree = await tx.$queryRaw<CommentRemovalPlan['subtree']>`
    WITH RECURSIVE subtree AS (
      SELECT id, patch_id, resource_id, status
      FROM patch_comment
      WHERE id = ANY(${roots.map((row) => row.id)}::int[])
      UNION
      SELECT pc.id, pc.patch_id, pc.resource_id, pc.status
      FROM patch_comment pc
      INNER JOIN subtree s ON pc.parent_id = s.id
    )
    SELECT id, patch_id, resource_id, status FROM subtree`

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
