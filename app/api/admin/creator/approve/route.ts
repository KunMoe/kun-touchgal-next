import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { createMessage } from '~/app/api/utils/message'
import { approveCreatorSchema } from '~/validations/admin'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { kunTx } from '~/server/db/tx'
import { KUN_ROLE } from '~/constants/role'

const approveCreator = async (
  input: z.infer<typeof approveCreatorSchema>,
  adminUid: number
) => {
  const { messageId, uid } = input
  const message = await prisma.user_message.findUnique({
    where: { id: messageId }
  })
  if (!message || message.type !== 'apply') {
    return '未找到该创作者请求'
  }
  if (message.sender_id !== uid) {
    return '申请人与目标用户不匹配'
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

  const failure = await kunTx('admin.creator.approve', async (ctx) => {
    const { tx: prisma } = ctx
    // 幂等闸门: 仅未处理 (0/1) 的申请可通过, 防止重复处理与并发双击
    const handled = await prisma.user_message.updateMany({
      where: { id: messageId, status: { in: [0, 1] } },
      // status: 0 - unread, 1 - read, 2 - approve, 3 - decline
      data: { status: { set: 2 } }
    })
    if (!handled.count) {
      ctx.fail('该申请已被处理, 请刷新后重试')
    }

    // 仅提升普通用户, 避免把积压申请期间已提拔的管理员降级;
    // 命中 0 行不算失败, 申请照样标记通过
    await applyKunCredentialChange(prisma, {
      uid,
      event: 'creator-approved',
      where: { role: { lt: KUN_ROLE.CREATOR } },
      data: { role: { set: KUN_ROLE.CREATOR } }
    })

    await createMessage(
      {
        type: 'apply',
        content: '恭喜，您的创作者申请已通过！',
        recipient_id: message.sender_id ?? undefined,
        link: '/apply/success'
      },
      prisma
    )

    await prisma.admin_log.create({
      data: {
        type: 'approve',
        user_id: adminUid,
        content: `管理员 ${admin.name} 同意了一位创作者申请\n\n创作者信息:\n用户名:${creator.name}\n已发布资源数:${creator._count.patch_resource}`
      }
    })
  })
  if (typeof failure === 'string') {
    return failure
  }
  // 升权: 策略表只失效会话缓存, 不登出
  await finishKunSecurityEvent(uid, 'creator-approved')
  await invalidateUnread(uid).catch(() => undefined)
  return {}
}

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: approveCreatorSchema,
  handler: ({ input, actor }) => approveCreator(input, actor.uid)
})
