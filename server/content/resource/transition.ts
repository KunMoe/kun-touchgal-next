import { recalcPatchType } from '~/app/api/patch/resource/_helper'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import {
  enqueueSearchOutboxBatch,
  kickSearchOutboxDrain
} from '~/server/search/sync'
import { settleOpenTasks } from '~/server/content/derivatives'
import { recordContentChanges } from '~/server/content/changes'
import { lockPatchRows } from '~/server/content/patchLock'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { ResourceStatus } from '~/constants/contentStatus'
import type { OpenTasksPolicy } from '~/server/content/derivatives'
import type { KunTxContext } from '~/server/db/tx'

// 资源的状态迁移。返回锁下真正发生迁移的行 (连同迁移前的状态)。
// 锁序固定为「资源行 → patch 行 → 审核任务 → patch 通告锁」, 与审核裁决、删除一致
export const transitionResources = async (
  ctx: KunTxContext,
  ids: number[],
  options: {
    from: readonly ResourceStatus[]
    to: ResourceStatus
    // 随状态一起写的字段 (申诉通过时写回申诉的名称与备注)
    data?: Omit<Prisma.patch_resourceUpdateManyMutationInput, 'status'>
    openTasks: OpenTasksPolicy
  }
) => {
  const { tx } = ctx
  const locked = await tx.$queryRaw<
    Array<{
      id: number
      user_id: number
      patch_id: number
      status: ResourceStatus
      section: string
    }>
  >`
    SELECT id, user_id, patch_id, status, section
    FROM patch_resource
    WHERE id = ANY(${ids}::int[])
    ORDER BY id
    FOR UPDATE`
  const moving = locked.filter((row) => options.from.includes(row.status))
  if (!moving.length) {
    return []
  }
  const movingIds = moving.map((row) => row.id)
  // 去重升序: patch 行锁与 recalcPatchType 内的 patch 级通告锁都按这个顺序获取, 两个
  // 批次不论资源行怎么交错都不会互等
  const patchIds = [...new Set(moving.map((row) => row.patch_id))].sort(
    (a, b) => a - b
  )
  await lockPatchRows(tx, patchIds)

  // 行已在锁下按 from 过滤过; where 里的 status 是双保险
  await tx.patch_resource.updateMany({
    where: { id: { in: movingIds }, status: { in: [...options.from] } },
    data: { ...options.data, status: options.to }
  })
  await settleOpenTasks(tx, 'resource', movingIds, options.openTasks)

  // 可见集变了, 补丁的 type / language / platform 聚合要重算
  for (const patchId of patchIds) {
    const uniqueId = await recalcPatchType(patchId, tx)
    // 事务内失效会被并发读回填旧值 (M-04), 所以放到提交之后
    ctx.afterCommit(`patchContent:${uniqueId}`, () =>
      invalidatePatchContentCache(uniqueId)
    )
  }
  // 搜索在事务内入箱, 与补丁变更原子提交; 提交后只需踢一次消费
  await enqueueSearchOutboxBatch(tx, patchIds)
  ctx.afterCommit('searchOutboxKick', () => kickSearchOutboxDrain())

  recordContentChanges(
    ctx,
    moving.map((row) => ({
      kind: 'resource',
      id: row.id,
      patchId: row.patch_id,
      ownerId: row.user_id,
      before: { status: row.status, section: row.section },
      after: { status: options.to, section: row.section }
    }))
  )
  return moving.map((row) => ({ id: row.id, from: row.status }))
}
