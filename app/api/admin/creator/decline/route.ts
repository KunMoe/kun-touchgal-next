import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createMessage } from '~/app/api/utils/message'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { declineCreatorSchema } from '~/validations/admin'
import { invalidateUnread } from '~/app/api/message/unread/cache'

const approveCreator = async (
  input: z.infer<typeof declineCreatorSchema>,
  adminUid: number
) => {
  const { messageId, reason } = input
  const message = await prisma.user_message.findUnique({
    where: { id: messageId }
  })
  if (!message || message.type !== 'apply') {
    return '未找到该创作者请求'
  }
  const creator = await prisma.user.findUnique({
    where: { id: message.sender_id ?? 0 },
    include: {
      _count: {
        select: {
          patch_resource: true
        }
      }
    }
  })
  if (!creator) {
    return '未找到该创作者'
  }
  const admin = await prisma.user.findUnique({ where: { id: adminUid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const result = await prisma.$transaction(async (prisma) => {
    // 幂等闸门: 仅未处理 (0/1) 的申请可拒绝, 同时挡掉「通过后再拒绝」;
    // 命中 0 行时事务内尚无任何写入, 提前返回提交空事务无害
    const handled = await prisma.user_message.updateMany({
      where: { id: messageId, status: { in: [0, 1] } },
      // status: 0 - unread, 1 - read, 2 - approve, 3 - decline
      data: { status: { set: 3 } }
    })
    if (!handled.count) {
      return '该申请已被处理, 请刷新后重试'
    }

    await createMessage(
      {
        type: 'apply',
        content: `您的创作者申请未通过，原因：${reason}`,
        recipient_id: message.sender_id ?? undefined,
        link: '/'
      },
      prisma
    )

    await prisma.admin_log.create({
      data: {
        type: 'decline',
        user_id: adminUid,
        content: `管理员 ${admin.name} 拒绝了一位创作者申请\n\n拒绝原因:${reason}\n创作者信息:\n用户名:${creator.name}\n已发布资源数:${creator._count.patch_resource}`
      }
    })

    return {}
  })
  if (typeof result === 'string') {
    return result
  }
  if (message.sender_id) {
    await invalidateUnread(message.sender_id).catch(() => undefined)
  }
  return result
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, declineCreatorSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 4) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const response = await approveCreator(input, payload.uid)
  return NextResponse.json(response)
}
