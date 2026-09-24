import * as z from 'zod'
import { isPrismaTransactionConflict, prisma } from '~/prisma/index'
import { deleteKunToken } from '~/app/api/utils/jwt'
import { deleteResource } from '../resource/delete'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import {
  invalidatePatchContentCache,
  invalidatePatchContentCacheByPatchId
} from '~/app/api/patch/cache'
import { recomputePatchRatingStats } from '~/app/api/patch/rating/stat'
import { invalidateTagListCache } from '~/app/api/tag/cache'
import { invalidateCompanyListCache } from '~/app/api/company/cache'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import {
  enqueueResourceLinkDeletions,
  recalcPatchType
} from '~/app/api/patch/resource/_helper'
import { deleteOrphanReports } from '~/server/report/pending'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import {
  enqueueSearchOutbox,
  kickSearchOutboxDrain
} from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'

const userIdSchema = z.object({
  uid: z.coerce.number({ message: '用户 ID 必须为数字' }).min(1).max(9999999)
})

export const deleteUser = async (
  input: z.infer<typeof userIdSchema>,
  uid: number
) => {
  const user = await prisma.user.findUnique({
    where: { id: input.uid },
    select: { id: true, name: true, email: true, role: true, status: true }
  })
  if (!user) {
    return '未找到用户'
  }
  if (input.uid === uid) {
    return '请勿删除自己'
  }

  const admin = await prisma.user.findUnique({
    where: { id: uid },
    select: { id: true, name: true }
  })
  if (!admin) {
    return '未找到管理员'
  }

  const patchResourceS3Ids = await prisma.patch_resource.findMany({
    where: {
      user_id: input.uid,
      links: {
        some: {
          storage: 's3'
        }
      }
    },
    select: { id: true }
  })
  const resourceIds = patchResourceS3Ids.map((s) => s.id)
  const publicResourceCount = await prisma.patch_resource.count({
    where: {
      user_id: input.uid,
      section: 'patch',
      status: 0
    }
  })
  // 资源详情缓存装 status=0 的全部 section, 资源列表只列 section='patch',
  // 故两个计数各驱动一个失效
  const publicAnySectionResourceCount = await prisma.patch_resource.count({
    where: {
      user_id: input.uid,
      status: 0
    }
  })
  // 删除前收集该用户 status=0 评论涉及的 patch, 级联删除后逐个失效评论缓存
  const commentedPatches = await prisma.patch_comment.findMany({
    where: { user_id: input.uid, status: 0 },
    select: { patch_id: true },
    distinct: ['patch_id']
  })
  // 删除前收集该用户点赞过的他人公开资源所在 patch: 点赞随 user.delete() 级联消失,
  // 详情缓存内嵌 likeCount 且版本键按 patch 分片, 不失效会陈旧至 TTL。
  // status=0 缓存才装; 自己的 patch 级联删后不可达, 残留缓存自然过期故排除
  const likedResourcePatches = await prisma.patch_resource.findMany({
    where: {
      like_by: { some: { user_id: input.uid } },
      status: 0,
      patch: { user_id: { not: input.uid } }
    },
    select: { patch_id: true },
    distinct: ['patch_id']
  })

  if (resourceIds.length) {
    for (const res of resourceIds) {
      await deleteResource({ resourceIds: [res] }, uid)
    }
  }

  let result: Record<string, never>
  let affectedPatchIds: number[] = []
  let affectedUniqueIds: string[] = []
  let ratingAffectedPatchIds: number[] = []
  let ownPatchUniqueIds: string[] = []
  let ownPatchHasPublicResource = false
  let ownS3Links: Parameters<typeof enqueueResourceLinkDeletions>[1] = []
  let retryCount = 0
  while (true) {
    try {
      result = await prisma.$transaction(
        async (prisma) => {
          // Serializable 使「读取受影响 patch → 级联删除 → 重算」成为同一数据库快照;
          // 并发新增评价或 status 迁移会使其中一个事务回滚, 不会提交漏算结果
          const ratedPatches = await prisma.patch_rating.findMany({
            where: { user_id: input.uid },
            select: {
              patch_id: true,
              status: true,
              patch: { select: { user_id: true } }
            }
          })

          // 该用户在他人补丁下的资源随 user.delete() 级联消失, 但 patch 的
          // type/language/platform 聚合不会自动重算. S3 资源已由上方 deleteResource
          // 各自重算, 此处 Serializable 快照只读到剩余的非 S3 资源 (漏算集);
          // 自己的 patch 会被级联删故过滤掉. 排序固定通告锁序, 与 hidden.ts 同理避免死锁
          const resourcePatches = await prisma.patch_resource.findMany({
            where: {
              user_id: input.uid,
              patch: { user_id: { not: input.uid } }
            },
            select: { patch_id: true },
            distinct: ['patch_id']
          })
          affectedPatchIds = resourcePatches
            .map((resource) => resource.patch_id)
            .sort((a, b) => a - b)

          // 自有 patch 随 user.delete() 级联消失, 连同其下所有人的资源/评论/评分,
          // 而级联绕过应用层 (S3 出箱/审核任务/申诉/搜索索引均无人清理), 故复用
          // deletePatchById 的清理序列。锁序与其一致 (先 patch_resource 后
          // patch/user), 单语句全局升序取锁; links 必须锁下重读: 快照与级联删除
          // 之间的并发重绑会换 s3 对象, 快照入队漏删新对象 (永无二次机会)
          const ownPatches = await prisma.patch.findMany({
            where: { user_id: input.uid },
            select: { id: true, unique_id: true }
          })
          const ownPatchIds = ownPatches
            .map((patch) => patch.id)
            .sort((a, b) => a - b)
          // 覆盖式赋值: Serializable 重试时不累加 (与 affectedUniqueIds 同理)
          ownPatchUniqueIds = ownPatches.map((patch) => patch.unique_id)
          ownPatchHasPublicResource = false
          ownS3Links = []
          let ownResourceIds: number[] = []
          let ownCommentIds: number[] = []
          let ownRatingIds: number[] = []
          if (ownPatchIds.length) {
            await prisma.$queryRaw`
              SELECT id FROM patch_resource WHERE patch_id = ANY(${ownPatchIds}::int[]) ORDER BY id FOR UPDATE`
            const ownResources = await prisma.patch_resource.findMany({
              where: { patch_id: { in: ownPatchIds } },
              include: { links: true }
            })
            ownS3Links = ownResources.flatMap((resource) =>
              resource.links
                .filter((link) => link.storage === 's3')
                .map((link) => ({
                  content: link.content,
                  patchId: resource.patch_id,
                  hash: link.hash,
                  s3Key: link.s3_key
                }))
            )
            ownResourceIds = ownResources.map((resource) => resource.id)
            // 他人在自有 patch 下的公开资源不计入本人计数闸门, 单独驱动列表失效
            ownPatchHasPublicResource = ownResources.some(
              (resource) =>
                resource.status === 0 && resource.section === 'patch'
            )
            const [ownComments, ownRatings] = await Promise.all([
              prisma.patch_comment.findMany({
                where: { patch_id: { in: ownPatchIds } },
                select: { id: true }
              }),
              prisma.patch_rating.findMany({
                where: { patch_id: { in: ownPatchIds } },
                select: { id: true }
              })
            ])
            ownCommentIds = ownComments.map((comment) => comment.id)
            ownRatingIds = ownRatings.map((rating) => rating.id)
          }

          await prisma.user.delete({
            where: { id: input.uid }
          })

          // 第三方内容被间接级联 (他人对该用户评论的回复经 parent_id、
          // 他人在该用户非 S3 资源下的评论经 resource_id) 会把针对它们的
          // 举报 comment_id 置空, 删除后按 NULL 目标清理孤儿 (锁序要求见
          // pending.ts)。rating 无此间接链: 他人评分只能随 patch 级联删,
          // 届时举报已因 patch_id Cascade 同删, 故不清 'rating'
          await deleteOrphanReports('comment', prisma)

          // 与 deletePatchById 对齐: 清理置于删除后, 与 submitAppeal 的内容行锁
          // 配合, 杜绝并发申诉提交造成的 TOCTOU 孤儿; 本人内容的任务/申诉已随
          // user_id 级联删除, 此处 deleteMany 幂等, 只兜他人内容的孤儿
          if (ownPatchIds.length) {
            await enqueueResourceLinkDeletions(prisma, ownS3Links)
            await deletePendingModerationTasks('comment', ownCommentIds, prisma)
            await deletePendingModerationTasks('rating', ownRatingIds, prisma)
            await deletePendingModerationTasks(
              'resource',
              ownResourceIds,
              prisma
            )
            await deletePendingAppeals('comment', ownCommentIds, prisma)
            await deletePendingAppeals('rating', ownRatingIds, prisma)
            await deletePendingAppeals('resource', ownResourceIds, prisma)
            // 自有 patch 的索引文档须入箱移除, 否则只能等次日 reconcile 兜底
            for (const patchId of ownPatchIds) {
              await enqueueSearchOutbox(prisma, patchId)
            }
          }

          // 覆盖式赋值: Serializable 重试时不累加 (与 affectedUniqueIds 同理)
          const ratingPatchIds = ratedPatches
            .filter(
              (rating) =>
                rating.status === 0 && rating.patch.user_id !== input.uid
            )
            .map((rating) => rating.patch_id)
          await recomputePatchRatingStats(ratingPatchIds, prisma)
          ratingAffectedPatchIds = ratingPatchIds

          // 级联删除已移除资源行但不触发聚合重算, 补齐之
          // (patch 内容缓存失效已移出事务, 由提交后统一失效; 与 create/update/delete/hidden 一致)
          // 事务性入队与重算同循环：与补丁变更原子提交，关闭崩溃丢失窗口
          // 局部数组每次 attempt 重建并覆盖式赋值, 使 Serializable 重试不累加脏条目
          const uniqueIds: string[] = []
          for (const patchId of affectedPatchIds) {
            uniqueIds.push(await recalcPatchType(patchId, prisma))
            await enqueueSearchOutbox(prisma, patchId)
          }
          affectedUniqueIds = uniqueIds

          await prisma.admin_log.create({
            data: {
              type: 'delete',
              user_id: uid,
              content: `管理员 ${admin.name} 删除了一个用户\n\n${JSON.stringify(user)}`
            }
          })

          return {}
        },
        { timeout: 60000, isolationLevel: 'Serializable' }
      )
      break
    } catch (error) {
      if (!isPrismaTransactionConflict(error) || retryCount >= 2) {
        throw error
      }
      retryCount++
    }
  }

  await Promise.all([invalidateTagListCache(), invalidateCompanyListCache()])
  await deleteKunToken(input.uid)
  if (publicAnySectionResourceCount > 0) {
    // affectedPatchIds 覆盖需失效的 patch: S3 资源已由上方 deleteResource 各自失效,
    // 自己的 patch 被级联删除后详情页不可达, 残留缓存条目 60s 内自然过期
    await Promise.all(
      affectedPatchIds.map((patchId) =>
        invalidatePatchResourceDetailCache(patchId)
      )
    )
  }
  // 他人在自有 patch 下的公开资源随级联消失但不计入本人计数, 由独立旗标驱动
  if (publicResourceCount > 0 || ownPatchHasPublicResource) {
    await invalidateResourceListCache()
  }
  // 点赞级联删除改他人 patch 的资源 likeCount, 不进上方闸门 (零资源用户也可能有点赞)
  const invalidatedDetailIds = new Set(
    publicAnySectionResourceCount > 0 ? affectedPatchIds : []
  )
  await Promise.all(
    likedResourcePatches
      .map((r) => r.patch_id)
      .filter((patchId) => !invalidatedDetailIds.has(patchId))
      .map((patchId) => invalidatePatchResourceDetailCache(patchId))
  )
  await Promise.all(
    commentedPatches.map((c) => invalidatePatchCommentCache(c.patch_id))
  )
  // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入。
  // 自有 patch 删除后 URL 仍可达而缓存键按 unique_id 构成, 不失效会陈旧展示至 TTL
  await Promise.all(
    [...affectedUniqueIds, ...ownPatchUniqueIds].map((uniqueId) =>
      invalidatePatchContentCache(uniqueId).catch(() => undefined)
    )
  )
  // 级联删除的公开评论/评分改 _count.comment 与 ratingSummary, 失效对应 patch 详情缓存 (M-05)
  await invalidatePatchContentCacheByPatchId([
    ...commentedPatches.map((c) => c.patch_id),
    ...ratingAffectedPatchIds
  ]).catch(() => undefined)
  // 事务内已入 S3 删除出箱, 提交后即时消费; 抢不到锁由定时任务兜底
  if (ownS3Links.length > 0) {
    kickS3DeletionDrain()
  }
  // 事务内已逐 id 入队，此处一次 kick 触发 drain 处理整箱（避免逐 id 各 kick）
  kickSearchOutboxDrain()

  return result
}
