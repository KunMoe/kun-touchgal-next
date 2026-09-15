import { z } from 'zod'
import { prisma } from '~/prisma/index'
import {
  cleanupResourceCommentDerivatives,
  enqueueResourceLinkDeletions,
  recalcPatchType
} from './_helper'
import { invalidatePatchResourceDetailCache } from './cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'
import { enqueueSearchOutbox, queueSearchSync } from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'

const resourceIdSchema = z.object({
  resourceId: z.coerce
    .number({ message: '资源 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

// 预检与行锁之间被并发删除/隐藏: 抛出以回滚先行的扣分写入 (对齐 decline 的哨兵模式)
class ResourceGoneError extends Error {}
// 预检与行锁之间被并发送审 (0→3): 同样必须 throw 回滚误扣
class ResourceModerationPendingError extends Error {}

export const deleteResource = async (
  input: z.infer<typeof resourceIdSchema>,
  uid: number,
  userRole: number
) => {
  // 事务外预检仅做权限与状态快速失败; links 不从这里取 —— 快照与事务之间的并发
  // 重绑会换 s3_key, 级联删除又绕过应用层, 入队事实源必须是锁下重读的集合
  const patchResource = await prisma.patch_resource.findUnique({
    where: { id: input.resourceId }
  })
  // 隐藏 (status=1) 的资源仅后台可管理, 前端与不存在等同
  if (!patchResource || patchResource.status === 1) {
    return '未找到对应的资源'
  }

  const resourceUserUid = patchResource.user_id
  if (patchResource.user_id !== uid && userRole < 3) {
    return '您没有权限删除该资源'
  }
  // 待初次审核 (status=2) / 待审核 (status=3) 的资源禁止作者删除; 管理员可删
  if (userRole < 3 && patchResource.status !== 0) {
    return '该资源正在审核中, 暂时无法删除'
  }

  let affectedUniqueId = ''
  let deletedResource
  try {
    deletedResource = await prisma.$transaction(async (prisma) => {
      // 扣分先行: 锁序 (user → patch_resource) 与 moderation apply 一致,
      // resource 锁在前会与 apply 的 user 先行锁构成 AB-BA 死锁
      await prisma.user.update({
        where: { id: resourceUserUid },
        data: { moemoepoint: { increment: -3 } }
      })
      // 行锁: 与 update / moderation apply 的 FOR UPDATE 互斥, 拿到锁即并发编辑
      // 要么已提交 (下面重读见新集合), 要么将阻塞至本事务提交后在锁下复检发现行已删
      const [locked] = await prisma.$queryRaw<
        Array<{ id: number; status: number }>
      >`SELECT id, status FROM patch_resource WHERE id = ${input.resourceId} FOR UPDATE`
      // 锁下复检事务外守卫 (7ba41379 同型): 预检与行锁之间的并发隐藏 (0→1) /
      // 送审 (0→3) 若不复检, 作者会物理删除管理员刚隐藏或已送审的行 —— 行锁的
      // 阻塞恰恰保证本事务在并发提交之后才继续, 删除必然落在新状态上.
      // 上面已有扣分写入, return 字符串会提交误扣, 必须 throw 回滚
      if (!locked || locked.status === 1) {
        throw new ResourceGoneError()
      }
      if (userRole < 3 && locked.status !== 0) {
        throw new ResourceModerationPendingError()
      }
      // 锁下重读 links: 删除瞬间的真实集合, 并发重绑产生的新 s3 对象不再漏入队
      const lockedLinks = await prisma.patch_resource_link.findMany({
        where: { resource_id: input.resourceId }
      })
      const s3Links = lockedLinks.filter((link) => link.storage === 's3')

      await cleanupResourceCommentDerivatives(prisma, input.resourceId)
      // 提交后的失效闸门读这里的返回值而非事务外快照: 快照与删除之间的并发 approve
      // (2→0) 或隐藏 (0→1) 会让闸门误判该行删除时是否在 status=0 集合里
      const deleted = await prisma.patch_resource.delete({
        where: { id: input.resourceId }
      })
      await deletePendingModerationTasks('resource', input.resourceId, prisma)
      await deletePendingAppeals('resource', input.resourceId, prisma)
      await deleteOrphanReports('comment', prisma)
      affectedUniqueId = await recalcPatchType(patchResource.patch_id, prisma)
      // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
      await enqueueSearchOutbox(prisma, patchResource.patch_id)
      // 事务性入队 S3 删除：与行删除原子提交，取代提交后 Promise.all 的不可恢复删除
      await enqueueResourceLinkDeletions(
        prisma,
        s3Links.map((link) => ({
          content: link.content,
          patchId: patchResource.patch_id,
          hash: link.hash,
          s3Key: link.s3_key
        }))
      )
      return deleted
    })
  } catch (error) {
    if (error instanceof ResourceGoneError) {
      return '未找到对应的资源'
    }
    if (error instanceof ResourceModerationPendingError) {
      return '该资源正在审核中, 暂时无法删除'
    }
    throw error
  }

  queueSearchSync(patchResource.patch_id)
  // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入
  await invalidatePatchContentCache(affectedUniqueId).catch(() => undefined)
  await invalidateUserSession(resourceUserUid)

  if (deletedResource.status === 0) {
    await invalidatePatchResourceDetailCache(patchResource.patch_id)
    if (deletedResource.section === 'patch') {
      await invalidateResourceListCache()
    }
  }

  // 管理员删除待审核 (2/3) 资源: 作者 hasPendingResource 可能翻假, 失效以尽早停止 bypass
  if (deletedResource.status === 2 || deletedResource.status === 3) {
    await invalidateUserPendingResourceCache(resourceUserUid)
  }

  // 即时消费删除出箱；抢不到锁则由定时任务兜底
  kickS3DeletionDrain()

  return {}
}
