import {
  cleanupResourceCommentDerivatives,
  enqueueResourceLinkDeletions,
  recalcPatchType
} from '~/app/api/patch/resource/_helper'
import { recordKunChanges } from '~/server/cache/publish'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { deleteOrphanReports } from '~/server/report/pending'
import {
  enqueueSearchOutboxBatch,
  kickSearchOutboxDrain
} from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'
import { purgeContentDerivatives } from '~/server/content/derivatives'
import { recordContentChanges } from '~/server/content/changes'
import { applyContentGuard } from '~/server/content/guard'
import { lockPatchRows } from '~/server/content/patchLock'
import { revokeCredits } from '~/server/points/account'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { ResourceStatus } from '~/constants/contentStatus'
import type { ContentGuard, SkippedContent } from '~/server/content/guard'
import type { KunTxContext } from '~/server/db/tx'

// 资源的物理删除。两段式: plan 只加锁和读取, execute 按固定顺序清理并删除。
// 入口夹在两段之间做自己的事 (判定结果、取审计所需的数据), 并把 skipped 映射成自己的文案

export type ResourceRemovalGuard = ContentGuard<ResourceStatus>

type ResourceRow = Prisma.patch_resourceGetPayload<{ include: { links: true } }>

export type SkippedResource = SkippedContent<ResourceStatus>

export interface ResourceRemovalPlan {
  // 锁下通过守卫的资源, 连同锁下重读的链接: 删除瞬间的真实集合
  rows: ResourceRow[]
  skipped: SkippedResource[]
  refundPublishReward: boolean
}

export const planResourceRemoval = async (
  { tx }: KunTxContext,
  ids: number[],
  options: {
    guard?: ResourceRemovalGuard
    // 是否收回发布奖励。没有默认值: 每个入口都要表态。扣分在 execute 里删除之后才写,
    // 守卫没过就不会发生; 作者的 user 行是最后一层锁 (见 revokeCredits), 这里不预先锁
    refundPublishReward: boolean
  }
): Promise<ResourceRemovalPlan> => {
  // 升序锁资源行: 与编辑、审核裁决的 FOR UPDATE 互斥, 批与批之间不会在资源行上反序
  const locked = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id
    FROM patch_resource
    WHERE id = ANY(${ids}::int[])
    ORDER BY id
    FOR UPDATE`
  // 锁下重读行与链接: 守卫、S3 入队与提交后的缓存失效都以删除瞬间的状态为准。事务外
  // 的快照与删除之间, 并发编辑会重绑 s3 对象, 并发的初审通过 / 隐藏会改 status
  const current = locked.length
    ? await tx.patch_resource.findMany({
        where: { id: { in: locked.map((row) => row.id) } },
        include: { links: true }
      })
    : []
  const { passed: rows, skipped } = applyContentGuard(
    ids,
    current,
    options.guard
  )
  // 删除公开资源会触发计数触发器去改 patch 行, 之后还要逐个补丁重算聚合
  await lockPatchRows(tx, [...new Set(rows.map((row) => row.patch_id))])
  return { rows, skipped, refundPublishReward: options.refundPublishReward }
}

export const executeResourceRemoval = async (
  ctx: KunTxContext,
  plan: ResourceRemovalPlan
) => {
  const deletedIds = plan.rows.map((row) => row.id)
  // 没有任何资源通过守卫: 不清理、不删除、不扣分。内容保留时它评论区的通知、
  // 任务、申诉、举报都要留着
  if (!deletedIds.length) {
    return { deletedIds }
  }
  const { tx } = ctx

  // 资源评论随外键级联删除, 它们的站内信、审核任务与申诉须在删除前清 (之后无从收集)
  await cleanupResourceCommentDerivatives(tx, deletedIds)
  await tx.patch_resource.deleteMany({ where: { id: { in: deletedIds } } })
  await purgeContentDerivatives(tx, { resource: deletedIds })
  // 级联删掉的评论上的举报已被置空目标, 按 NULL 目标清理
  await deleteOrphanReports('comment', tx)

  if (plan.refundPublishReward) {
    const owners = await revokeCredits(
      tx,
      'resource_publish',
      plan.rows.map((row) => row.user_id)
    )
    for (const ownerId of owners) {
      ctx.afterCommit(`userSession:${ownerId}`, () =>
        invalidateUserSession(ownerId)
      )
    }
  }

  // 去重升序: recalcPatchType 内的 patch 级通告锁按确定的顺序获取, 与 plan 里预锁
  // patch 行的顺序一致
  const patchIds = [...new Set(plan.rows.map((row) => row.patch_id))].sort(
    (a, b) => a - b
  )
  for (const patchId of patchIds) {
    const uniqueId = await recalcPatchType(patchId, tx)
    recordKunChanges(ctx, [{ kind: 'patch', patchId, uniqueId }])
  }
  // 搜索与 S3 删除都在事务内入箱, 与行删除原子提交; 提交后只需踢一次消费
  await enqueueSearchOutboxBatch(tx, patchIds)
  ctx.afterCommit('searchOutboxKick', () => kickSearchOutboxDrain())
  await enqueueResourceLinkDeletions(
    tx,
    plan.rows.flatMap((row) =>
      row.links
        .filter((link) => link.storage === 's3')
        .map((link) => ({
          content: link.content,
          patchId: row.patch_id,
          hash: link.hash,
          s3Key: link.s3_key
        }))
    )
  )

  recordContentChanges(
    ctx,
    plan.rows.map((row) => ({
      kind: 'resource',
      id: row.id,
      patchId: row.patch_id,
      ownerId: row.user_id,
      before: { status: row.status as ResourceStatus, section: row.section },
      after: null
    }))
  )
  ctx.afterCommit('s3DeletionKick', () => kickS3DeletionDrain())

  return { deletedIds }
}
