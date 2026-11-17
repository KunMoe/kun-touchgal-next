import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createMessage } from '~/app/api/utils/message'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { approvePatchResourceSchema } from '~/validations/admin'
import { kunTx } from '~/server/db/tx'
import { RESOURCE_STATUS } from '~/constants/contentStatus'
import { transitionResources } from '~/server/content/resource/transition'
import { invalidateUnread } from '~/app/api/message/unread/cache'

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

  const result = await kunTx('admin.resource.approve', async (ctx) => {
    // 上面的状态检查在事务外。命令在行锁下再判一次「仍是待初审」: 并发的拒绝已删除
    // 该行, 或已被另一次通过处理时, 这里得到空集, 走字符串错误契约而不是 500。
    // 待初审的资源不送 AI 审核, 没有在途任务可作废
    const moved = await transitionResources(ctx, [resourceId], {
      from: [RESOURCE_STATUS.awaitingApproval],
      to: RESOURCE_STATUS.public,
      openTasks: 'keep'
    })
    if (!moved.length) {
      ctx.fail('当前资源状态无需审核')
    }

    await createMessage(
      {
        type: 'system',
        content: `您上传的资源「${resource.name || resource.patch.name}」已通过审核，感谢分享！`,
        recipient_id: resource.user_id,
        link: `/${resource.patch.unique_id}?tab=resources&resourceSection=${resource.section}&resourceId=${resource.id}`
      },
      ctx.tx
    )

    await ctx.tx.admin_log.create({
      data: {
        type: 'approve',
        user_id: adminUid,
        content: `管理员 ${admin.name} 审核通过了一条资源\n\nGalgame 名称:${resource.patch.name}\n资源 ID:${resource.id}\n资源标题:${resource.name}\n上传用户:${resource.user.name}`
      }
    })

    return {}
  })
  if (typeof result === 'string') {
    return result
  }

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
