import * as z from 'zod'
import { kunId } from '~/validations/primitives'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { enqueueResourceLinkDeletions } from './resource/_helper'
import { recordKunChanges } from '~/server/cache/publish'
import { purgeContentDerivatives } from '~/server/content/derivatives'
import { queueSearchRemove, enqueueSearchOutbox } from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'
import { enqueuePatchBannerDeletion } from '~/server/storage/patchBanner'
import type { ResourceStatus } from '~/constants/contentStatus'

const patchIdSchema = z.object({
  patchId: kunId('游戏 ID')
})

export const deletePatchById = async (input: z.infer<typeof patchIdSchema>) => {
  const { patchId } = input

  const patch = await prisma.patch.findUnique({
    where: { id: patchId }
  })
  if (!patch) {
    return '未找到该游戏'
  }

  const failure = await kunTx('patch.delete', async (ctx) => {
    const { tx: prisma } = ctx
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

    // delete 是单条 DELETE … RETURNING: 返回的 banner 就是删除那一刻的指针 (换封面在同一行锁下
    // 改它, 不会漏掉并发换上的新版本)
    const deleted = await prisma.patch.delete({
      where: { id: patchId }
    })
    // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
    await enqueueSearchOutbox(prisma, patchId)
    // 事务性入队 S3 删除：与行删除原子提交，取代提交后 Promise.all 的不可恢复删除
    await enqueueResourceLinkDeletions(prisma, s3Links)
    // 封面随游戏立即回收 (X06-01): 不留宽限期, 下架即生效
    await enqueuePatchBannerDeletion(prisma, patchId, deleted.banner)

    // 内容已级联删除, 删除后再清理其未决审核任务与未处理申诉 (content_id 无外键, 用删除前收集的 id);
    // 清理置于删除后, 与 submitAppeal 的内容行锁配合, 杜绝并发申诉提交造成的 TOCTOU 孤儿。
    // 评论区的站内信这里不清: 整游戏删除留下的通知死链已裁定另案处理
    await purgeContentDerivatives(prisma, {
      comment: comments.map((comment) => comment.id),
      rating: ratings.map((rating) => rating.id),
      resource: patchResources.map((resource) => resource.id)
    })

    // 资源行的状态取自上面锁下的重读
    recordKunChanges(ctx, [
      { kind: 'patchDeleted', patchId, uniqueId: patch.unique_id },
      ...patchResources.map((resource) => ({
        kind: 'resource' as const,
        id: resource.id,
        patchId,
        ownerId: resource.user_id,
        before: {
          status: resource.status as ResourceStatus,
          section: resource.section
        },
        after: null
      }))
    ])
  })
  if (typeof failure === 'string') {
    return failure
  }

  queueSearchRemove(patchId)

  // 即时消费删除出箱；抢不到锁则由定时任务兜底
  kickS3DeletionDrain()

  return {}
}
