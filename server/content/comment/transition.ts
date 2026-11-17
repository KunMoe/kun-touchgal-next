import { settleOpenTasks } from '~/server/content/derivatives'
import { recordContentChanges } from '~/server/content/changes'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { CommentStatus } from '~/constants/contentStatus'
import type { OpenTasksPolicy } from '~/server/content/derivatives'
import type { KunTxContext } from '~/server/db/tx'

// 评论的状态迁移。返回锁下真正发生迁移的行 (连同迁移前的状态): 审计、返回值与后续
// 判断都以它为准, 不以入口打算改的行为准。
// 锁序固定为「评论行 → 审核任务」, 与审核裁决、删除一致: 先锁行再作废任务, 作废的
// 集合才等于实际迁移的集合
export const transitionComments = async (
  ctx: KunTxContext,
  ids: number[],
  options: {
    from: readonly CommentStatus[]
    to: CommentStatus
    // 随状态一起写的字段 (申诉通过时写回申诉的正文)
    data?: Omit<Prisma.patch_commentUpdateManyMutationInput, 'status'>
    openTasks: OpenTasksPolicy
  }
) => {
  const { tx } = ctx
  const locked = await tx.$queryRaw<
    Array<{
      id: number
      patch_id: number
      resource_id: number | null
      status: CommentStatus
    }>
  >`
    SELECT id, patch_id, resource_id, status
    FROM patch_comment
    WHERE id = ANY(${ids}::int[])
    ORDER BY id
    FOR UPDATE`
  const moving = locked.filter((row) => options.from.includes(row.status))
  if (!moving.length) {
    return []
  }
  const movingIds = moving.map((row) => row.id)

  // 行已在锁下按 from 过滤过; where 里的 status 是双保险
  await tx.patch_comment.updateMany({
    where: { id: { in: movingIds }, status: { in: [...options.from] } },
    data: { ...options.data, status: options.to }
  })
  await settleOpenTasks(tx, 'comment', movingIds, options.openTasks)

  recordContentChanges(
    ctx,
    moving.map((row) => ({
      kind: 'comment',
      id: row.id,
      patchId: row.patch_id,
      resourceId: row.resource_id,
      before: row.status,
      after: options.to
    }))
  )
  return moving.map((row) => ({ id: row.id, from: row.status }))
}
