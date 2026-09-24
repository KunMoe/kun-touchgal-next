import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createMessage } from '~/app/api/utils/message'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { declinePatchResourceSchema } from '~/validations/admin'
import {
  cleanupResourceCommentDerivatives,
  enqueueResourceLinkDeletions,
  recalcPatchType
} from '~/app/api/patch/resource/_helper'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { deleteOrphanReports } from '~/server/report/pending'
import { queueSearchSync, enqueueSearchOutbox } from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'
import { invalidateUnread } from '~/app/api/message/unread/cache'

class DeclineResourceError extends Error {}

const declinePatchResource = async (
  input: z.infer<typeof declinePatchResourceSchema>,
  adminUid: number
) => {
  const { resourceId, reason } = input

  const resource = await prisma.patch_resource.findUnique({
    where: { id: resourceId },
    include: {
      user: true,
      patch: { select: { name: true, unique_id: true } }
    }
  })
  if (!resource) {
    return '该资源不存在'
  }

  const admin = await prisma.user.findUnique({ where: { id: adminUid } })
  if (!admin) {
    return '管理员不存在'
  }

  try {
    await prisma.$transaction(async (prisma) => {
      // 行锁先行 + 锁下重读 links: 管理员可编辑 status=2 的资源, 事务外快照与守卫
      // 删除之间的并发重绑会换 s3 对象, 用快照入队会漏删新对象 (级联删除绕过应用层)
      const [locked] = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM patch_resource WHERE id = ${resourceId} FOR UPDATE`
      if (!locked) {
        throw new DeclineResourceError('当前资源状态无需审核')
      }
      const lockedLinks = await prisma.patch_resource_link.findMany({
        where: { resource_id: resourceId }
      })
      const s3Links = lockedLinks.filter((link) => link.storage === 's3')

      // 评论衍生物必须在删除前清理: 删除后 patch_comment 已随级联消失, 无从收集 id
      await cleanupResourceCommentDerivatives(prisma, resourceId)
      // guarded delete 以 status 条件 + 行锁闭合"读状态→删除"窗口: 并发 approve (2→0)
      // 要么先提交使删除匹配 0 行而跳过, 要么被行锁阻塞后见新状态——不再误删已上线资源
      // (级联带走评论 + S3 出箱即时排空, 不可恢复). 零计数抛出回滚, 一并撤销上面的清理
      const removed = await prisma.patch_resource.deleteMany({
        where: { id: resourceId, status: 2 }
      })
      if (removed.count === 0) {
        throw new DeclineResourceError('当前资源状态无需审核')
      }
      await deleteOrphanReports('comment', prisma)
      await recalcPatchType(resource.patch_id, prisma)
      // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
      await enqueueSearchOutbox(prisma, resource.patch_id)
      // 事务性入队 S3 删除：与行删除原子提交，取代提交后 Promise.all 的不可恢复删除
      await enqueueResourceLinkDeletions(
        prisma,
        s3Links.map((link) => ({
          content: link.content,
          patchId: resource.patch_id,
          hash: link.hash,
          s3Key: link.s3_key
        }))
      )

      await createMessage(
        {
          type: 'system',
          content: `您上传的资源「${resource.name || resource.patch.name}」未通过审核，原因：${reason}`,
          recipient_id: resource.user_id,
          link: `/${resource.patch.unique_id}?tab=resources&resourceSection=${resource.section}`
        },
        prisma
      )

      await prisma.admin_log.create({
        data: {
          type: 'decline',
          user_id: adminUid,
          content: `管理员 ${admin.name} 拒绝了一条资源\n\n拒绝原因:${reason}\nGalgame 名称:${resource.patch.name}\n资源 ID:${resource.id}\n资源标题:${resource.name}\n上传用户:${resource.user.name}`
        }
      })
    })
  } catch (error) {
    // 守卫未命中: 必须在下面的提交后副作用之前返回, 否则会触发 S3 出箱排空
    if (error instanceof DeclineResourceError) {
      return error.message
    }
    throw error
  }

  queueSearchSync(resource.patch_id)
  // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入
  await invalidatePatchContentCache(resource.patch.unique_id).catch(
    () => undefined
  )

  // 带守卫的删除只匹配 status=2 的待审行, 它们不在资源列表 / 详情缓存的 status=0
  // 集合里: 下面的 status === 0 在守卫下恒不成立 (快照为 0 时删除匹配 0 行, 已抛
  // DeclineResourceError 提前返回), 详情缓存同理无需失效
  if (resource.section === 'patch' && resource.status === 0) {
    await invalidateResourceListCache()
  }

  // 拒绝即删除待审资源: 作者 hasPendingResource 可能翻假, 失效以尽早停止 bypass
  await invalidateUserPendingResourceCache(resource.user_id)

  await invalidateUnread(resource.user_id).catch(() => undefined)

  // 即时消费删除出箱；抢不到锁则由定时任务兜底
  kickS3DeletionDrain()

  return {}
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, declinePatchResourceSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('未登录')
  }
  if (payload.role < 4) {
    return NextResponse.json('仅超级管理员可访问')
  }

  const response = await declinePatchResource(input, payload.uid)
  return NextResponse.json(response)
}
