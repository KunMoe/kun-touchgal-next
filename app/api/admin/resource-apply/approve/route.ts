import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createMessage } from '~/app/api/utils/message'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { approvePatchResourceSchema } from '~/validations/admin'
import { recalcPatchType } from '~/app/api/patch/resource/_helper'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { queueSearchSync, enqueueSearchOutbox } from '~/server/search/sync'
import { invalidateUnread } from '~/app/api/message/unread/cache'

class ApproveResourceError extends Error {}

const approvePatchResource = async (
  input: z.infer<typeof approvePatchResourceSchema>,
  adminUid: number
) => {
  const { resourceId } = input

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
  if (resource.status !== 2) {
    return '当前资源状态无需审核'
  }

  const admin = await prisma.user.findUnique({ where: { id: adminUid } })
  if (!admin) {
    return '管理员不存在'
  }

  try {
    await prisma.$transaction(async (prisma) => {
      // updateMany 而非 update: 上面的状态检查在事务外, 并发 decline 已删除该行时
      // 裸 update 抛 P2025 逃逸为 500; 带 status 条件的零计数走字符串错误契约
      const approved = await prisma.patch_resource.updateMany({
        where: { id: resourceId, status: 2 },
        data: { status: 0 }
      })
      if (approved.count === 0) {
        throw new ApproveResourceError('当前资源状态无需审核')
      }
      await recalcPatchType(resource.patch_id, prisma)
      // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
      await enqueueSearchOutbox(prisma, resource.patch_id)

      await createMessage(
        {
          type: 'system',
          content: `您上传的资源「${resource.name || resource.patch.name}」已通过审核，感谢分享！`,
          recipient_id: resource.user_id,
          link: `/${resource.patch.unique_id}?tab=resources&resourceSection=${resource.section}&resourceId=${resource.id}`
        },
        prisma
      )

      await prisma.admin_log.create({
        data: {
          type: 'approve',
          user_id: adminUid,
          content: `管理员 ${admin.name} 审核通过了一条资源\n\nGalgame 名称:${resource.patch.name}\n资源 ID:${resource.id}\n资源标题:${resource.name}\n上传用户:${resource.user.name}`
        }
      })
    })
  } catch (error) {
    if (error instanceof ApproveResourceError) {
      return error.message
    }
    throw error
  }

  queueSearchSync(resource.patch_id)
  // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入
  await invalidatePatchContentCache(resource.patch.unique_id).catch(
    () => undefined
  )

  // 2→0 使该资源进入公开集: 详情缓存装两个 section, 故不分 section 无条件失效
  await invalidatePatchResourceDetailCache(resource.patch_id)

  if (resource.section === 'patch') {
    await invalidateResourceListCache()
  }

  // 资源通过人工审批 (2→0): 作者 hasPendingResource 可能翻假, 失效以尽早停止 bypass
  await invalidateUserPendingResourceCache(resource.user_id)

  await invalidateUnread(resource.user_id).catch(() => undefined)

  return {}
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, approvePatchResourceSchema)
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

  const response = await approvePatchResource(input, payload.uid)
  return NextResponse.json(response)
}
