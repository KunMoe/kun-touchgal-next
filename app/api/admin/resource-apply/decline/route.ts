import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createMessage } from '~/app/api/utils/message'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { declinePatchResourceSchema } from '~/validations/admin'
import { kunTx } from '~/server/db/tx'
import { RESOURCE_STATUS } from '~/constants/contentStatus'
import {
  executeResourceRemoval,
  planResourceRemoval
} from '~/server/content/resource/remove'
import { invalidateUnread } from '~/app/api/message/unread/cache'

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

  const result = await kunTx('admin.resource.decline', async (ctx) => {
    // 守卫在行锁下判定: 仍是待初审才删。并发的审核通过 (2→0) 要么先提交 (这里看到
    // 已上线, 跳过), 要么排在本事务之后 —— 不会误删已上线的资源 (删除会级联带走评论,
    // S3 对象也随出箱清掉, 不可恢复)。未通过时什么都不清理
    const plan = await planResourceRemoval(ctx, [resourceId], {
      guard: { statusIn: [RESOURCE_STATUS.awaitingApproval] },
      refundPublishReward: false
    })
    if (!plan.rows.length) {
      ctx.fail('当前资源状态无需审核')
    }
    await executeResourceRemoval(ctx, plan)

    await createMessage(
      {
        type: 'system',
        content: `您上传的资源「${resource.name || resource.patch.name}」未通过审核，原因：${reason}`,
        recipient_id: resource.user_id,
        link: `/${resource.patch.unique_id}?tab=resources&resourceSection=${resource.section}`
      },
      ctx.tx
    )

    await ctx.tx.admin_log.create({
      data: {
        type: 'decline',
        user_id: adminUid,
        content: `管理员 ${admin.name} 拒绝了一条资源\n\n拒绝原因:${reason}\nGalgame 名称:${resource.patch.name}\n资源 ID:${resource.id}\n资源标题:${resource.name}\n上传用户:${resource.user.name}`
      }
    })
  })
  if (typeof result === 'string') {
    return result
  }

  await invalidateUnread(resource.user_id).catch(() => undefined)

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
