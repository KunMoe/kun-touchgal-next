import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { enqueueResourceLinkDeletions } from './resource/_helper'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidateTagListCache } from '~/app/api/tag/cache'
import { invalidateCompanyListCache } from '~/app/api/company/cache'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { queueSearchRemove, enqueueSearchOutbox } from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'

const patchIdSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999)
})

export const deletePatchById = async (input: z.infer<typeof patchIdSchema>) => {
  const { patchId } = input

  const patch = await prisma.patch.findUnique({
    where: { id: patchId }
  })
  if (!patch) {
    return '未找到该游戏'
  }

  let shouldInvalidateResourceList = false
  const response = await prisma.$transaction(async (prisma) => {
    // 升序锁全部资源行: 与 update 的 FOR UPDATE 互斥, 锁序 (先 patch_resource 后
    // patch) 与 update 的「锁资源行 → patch.update」一致 —— 不可先锁 patch 行,
    // 会与 update 构成 AB-BA 死锁. links 必须锁下重读: 事务外快照与级联删除之间的
    // 并发重绑会换 s3 对象, 快照入队漏删新对象 (级联删除绕过应用层, 永无二次机会).
    // 已知残留: 锁不住尚不存在的行, 此后并发 createResource 的新资源仍会随级联
    // 删除孤儿化其 s3 对象 (须 patch 删除与资源新建同刻并发, 发生率极低)
    await prisma.$queryRaw`
      SELECT id FROM patch_resource WHERE patch_id = ${patchId} ORDER BY id FOR UPDATE`
    const patchResources = await prisma.patch_resource.findMany({
      where: { patch_id: patchId },
      include: {
        links: true
      }
    })

    const s3Links = patchResources.flatMap((resource) =>
      resource.links
        .filter((link) => link.storage === 's3')
        .map((link) => ({
          content: link.content,
          patchId: resource.patch_id,
          hash: link.hash,
          s3Key: link.s3_key
        }))
    )
    shouldInvalidateResourceList = patchResources.some(
      (resource) => resource.status === 0 && resource.section === 'patch'
    )

    // 级联删除会带走该游戏的全部资源/评论/评价, 先收集 id 供删除后清理未决审核任务与申诉
    const [comments, ratings] = await Promise.all([
      prisma.patch_comment.findMany({
        where: { patch_id: patchId },
        select: { id: true }
      }),
      prisma.patch_rating.findMany({
        where: { patch_id: patchId },
        select: { id: true }
      })
    ])

    await prisma.patch.delete({
      where: { id: patchId }
    })
    // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
    await enqueueSearchOutbox(prisma, patchId)
    // 事务性入队 S3 删除：与行删除原子提交，取代提交后 Promise.all 的不可恢复删除
    await enqueueResourceLinkDeletions(prisma, s3Links)

    // 内容已级联删除, 删除后再清理其未决审核任务与未处理申诉 (content_id 无外键, 用删除前收集的 id);
    // 清理置于删除后, 与 submitAppeal 的内容行锁配合, 杜绝并发申诉提交造成的 TOCTOU 孤儿
    await deletePendingModerationTasks(
      'comment',
      comments.map((comment) => comment.id),
      prisma
    )
    await deletePendingModerationTasks(
      'rating',
      ratings.map((rating) => rating.id),
      prisma
    )
    await deletePendingModerationTasks(
      'resource',
      patchResources.map((resource) => resource.id),
      prisma
    )
    await deletePendingAppeals(
      'comment',
      comments.map((comment) => comment.id),
      prisma
    )
    await deletePendingAppeals(
      'rating',
      ratings.map((rating) => rating.id),
      prisma
    )
    await deletePendingAppeals(
      'resource',
      patchResources.map((resource) => resource.id),
      prisma
    )

    return {}
  })

  queueSearchRemove(patchId)

  // 级联删除经 DB 触发器递减 tag/company 计数, 故需失效列表缓存;
  // content/introduction 缓存键由 URL 中的 unique_id 构成, 删除后仍可达,
  // 不失效则幽灵详情页存活至 TTL 过期
  await Promise.all([
    invalidateTagListCache(),
    invalidateCompanyListCache(),
    invalidatePatchContentCache(patch.unique_id).catch(() => undefined)
  ])

  // 不失效 patch 资源详情缓存: 该缓存按 patch_id 分键, 补丁连同详情页一并消失后其键
  // 不再可达, 而版本号是全站共享的, 递增只会白清其他补丁的缓存
  if (shouldInvalidateResourceList) {
    await invalidateResourceListCache()
  }

  // 即时消费删除出箱；抢不到锁则由定时任务兜底
  kickS3DeletionDrain()

  return response
}
