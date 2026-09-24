import * as z from 'zod'
import { isPrismaTransactionConflict, prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import {
  cleanupResourceCommentDerivatives,
  enqueueResourceLinkDeletions,
  recalcPatchType,
  sanitizeResourceLinksForAuditLog
} from '~/app/api/patch/resource/_helper'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'
import {
  enqueueSearchOutboxBatch,
  kickSearchOutboxDrain
} from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'
import { truncateLogContent } from '~/app/api/admin/_log'
import { adminDeleteResourceSchema } from '~/validations/admin'

const adminDeleteResourceSummaryLimit = 10

type DeletedResource = Prisma.patch_resourceGetPayload<{
  include: { patch: { select: { name: true } }; links: true }
}>

const buildDeleteLogContent = (
  adminName: string,
  resources: DeletedResource[]
) => {
  // 单条保持原有全量快照格式, 审计信息不退化
  if (resources.length === 1) {
    const [resource] = resources
    const sanitizedResource = {
      ...resource,
      links: sanitizeResourceLinksForAuditLog(resource.links)
    }
    // note 上限即 10007, 不截断会 22001 回滚整个删除事务
    return truncateLogContent(
      `管理员 ${adminName} 删除了一个资源\n\nGalgame 名:\n${resource.patch.name}\n\n资源信息:\n${JSON.stringify(sanitizedResource)}`
    )
  }

  // 批量: 全量 JSON 必然超 note 上限被整体截断, 改记全部 id + 前 N 条摘要
  const summaries = resources
    .slice(0, adminDeleteResourceSummaryLimit)
    .map((resource) => ({
      id: resource.id,
      name: resource.name,
      patchName: resource.patch.name,
      userId: resource.user_id,
      section: resource.section,
      status: resource.status,
      linkCount: resource.links.length
    }))
  const suffix =
    resources.length > summaries.length
      ? `\n其余 ${resources.length - summaries.length} 条资源摘要已省略`
      : ''

  return truncateLogContent(
    `管理员 ${adminName} 批量删除了 ${resources.length} 条资源\n资源 ID: ${resources
      .map((resource) => resource.id)
      .join(', ')}\n资源摘要: ${JSON.stringify(summaries)}${suffix}`
  )
}

export const deleteResource = async (
  input: z.infer<typeof adminDeleteResourceSchema>,
  uid: number
) => {
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  let deleteResult:
    string | { deleted: DeletedResource[]; affectedUniqueIds: string[] }
  let retryCount = 0
  while (true) {
    try {
      deleteResult = await prisma.$transaction(
        async (prisma) => {
          // 行锁先行: 与 update / moderation apply 的 FOR UPDATE 互斥, 锁序 (先
          // patch_resource, 后 patch 通告锁) 与其一致. 顶层 SELECT 带 ORDER BY 时
          // LockRows 在 Sort 之上, 批内按 id 升序加锁, 两个重叠批不会在资源行上 AB-BA
          const locked = await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT id FROM patch_resource WHERE id = ANY(${input.resourceIds}::int[]) ORDER BY id FOR UPDATE`
          // 此处尚无任何写入, return 业务错误仅提交空事务, 零副作用
          if (!locked.length) {
            return '未找到对应的资源'
          }
          const lockedIds = locked.map((row) => row.id)
          // 锁下重读行 + links + patch 名: S3 入队、审计日志与提交后的失效闸门都以
          // 删除瞬间状态为准 —— 事务外快照与删除之间的并发编辑会重绑 s3 对象, 并发
          // approve 2→0 / 隐藏 0→1 也会让快照误判该行删除时是否在 status=0 集合里
          const current = await prisma.patch_resource.findMany({
            where: { id: { in: lockedIds } },
            include: {
              patch: {
                select: {
                  name: true
                }
              },
              links: true
            }
          })
          const s3Links = current.flatMap((resource) =>
            resource.links
              .filter((link) => link.storage === 's3')
              .map((link) => ({
                content: link.content,
                patchId: resource.patch_id,
                hash: link.hash,
                s3Key: link.s3_key
              }))
          )

          await cleanupResourceCommentDerivatives(prisma, lockedIds)
          await prisma.patch_resource.deleteMany({
            where: { id: { in: lockedIds } }
          })
          await deletePendingModerationTasks('resource', lockedIds, prisma)
          await deletePendingAppeals('resource', lockedIds, prisma)
          await deleteOrphanReports('comment', prisma)

          // 去重升序: recalcPatchType 内的 patch 级通告锁按确定性顺序获取, 消除两个
          // 反序重叠批的 AB-BA 死锁 (与 hidden.ts 同理)
          const patchIds = [
            ...new Set(current.map((resource) => resource.patch_id))
          ].sort((a, b) => a - b)
          const affectedUniqueIds: string[] = []
          for (const patchId of patchIds) {
            affectedUniqueIds.push(await recalcPatchType(patchId, prisma))
          }
          // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口; 一条 SQL 入整批
          await enqueueSearchOutboxBatch(prisma, patchIds)
          // 事务性入队 S3 删除：与行删除原子提交，取代提交后 Promise.all 的不可恢复删除
          await enqueueResourceLinkDeletions(prisma, s3Links)

          await prisma.admin_log.create({
            data: {
              type: 'delete',
              user_id: uid,
              content: buildDeleteLogContent(admin.name, current)
            }
          })

          return { deleted: current, affectedUniqueIds }
        },
        // 批量上限 100 条且持锁期间还要跑评论派生清理, 默认 5s 交互事务超时余量不足
        { timeout: 60000 }
      )
      break
    } catch (error) {
      // 与批量隐藏的锁序 (task → 资源行) 相反, 重叠 id 上并发即 40P01; 事务已整体
      // 回滚, 无副作用, 重试即可
      if (!isPrismaTransactionConflict(error) || retryCount >= 2) {
        throw error
      }
      retryCount++
    }
  }
  if (typeof deleteResult === 'string') {
    return deleteResult
  }
  const { deleted: deletedResources, affectedUniqueIds } = deleteResult

  // 事务内已入箱, 提交后一次 kick 触发 drain 处理整箱 (避免二次入箱)
  kickSearchOutboxDrain()
  // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入
  await Promise.all(
    affectedUniqueIds.map((uniqueId) =>
      invalidatePatchContentCache(uniqueId).catch(() => undefined)
    )
  )

  const visiblePatchIds = [
    ...new Set(
      deletedResources
        .filter((resource) => resource.status === 0)
        .map((resource) => resource.patch_id)
    )
  ]
  await Promise.all(
    visiblePatchIds.map((patchId) =>
      invalidatePatchResourceDetailCache(patchId)
    )
  )
  if (
    deletedResources.some(
      (resource) => resource.status === 0 && resource.section === 'patch'
    )
  ) {
    await invalidateResourceListCache()
  }

  // 删除待审核 (2/3) 资源: 作者 hasPendingResource 可能翻假, 失效以尽早停止 bypass
  const pendingUserIds = [
    ...new Set(
      deletedResources
        .filter((resource) => resource.status === 2 || resource.status === 3)
        .map((resource) => resource.user_id)
    )
  ]
  await Promise.all(
    pendingUserIds.map((userId) => invalidateUserPendingResourceCache(userId))
  )

  // 即时消费删除出箱；抢不到锁则由定时任务兜底
  kickS3DeletionDrain()

  return { count: deletedResources.length }
}
