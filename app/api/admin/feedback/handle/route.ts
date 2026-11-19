import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { adminHandleFeedbackSchema } from '~/validations/admin'
import { sliceUntilDelimiterFromEnd } from '~/app/api/utils/sliceUntilDelimiterFromEnd'
import { createMessage } from '~/app/api/utils/message'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { kunTx } from '~/server/db/tx'

const handleFeedback = async (
  input: z.infer<typeof adminHandleFeedbackSchema>
) => {
  const message = await prisma.user_message.findUnique({
    where: { id: input.messageId }
  })
  // 与 admin 反馈列表的 where 对齐: 只接受用户提交的反馈行,
  // 排除其他类型消息与本路由自发的 sender_id 为空的「反馈已处理」通知
  if (!message || message.type !== 'feedback' || message.sender_id === null) {
    return '未找到该反馈'
  }
  // 提成 const: 属性收窄不会带进事务回调闭包
  const senderId = message.sender_id

  const SLICED_CONTENT = sliceUntilDelimiterFromEnd(message.content).slice(
    0,
    200
  )
  const handleResult = input.content ? input.content : '无处理留言'
  const feedbackContent = `您的反馈已处理\n\n反馈内容：${SLICED_CONTENT}\n处理回复：${handleResult}`

  const failure = await kunTx('admin.feedback.handle', async (ctx) => {
    const { tx: prisma } = ctx
    // 幂等闸门: 仅未处理 (0) 的反馈可命中, 防止并发双击重复通知
    const handled = await prisma.user_message.updateMany({
      where: { id: input.messageId, status: 0 },
      // status: 0 - unread, 1 - read, 2 - approve, 3 - decline
      data: { status: { set: 1 } }
    })
    if (!handled.count) {
      ctx.fail('该反馈已被处理')
    }

    await createMessage(
      {
        type: 'feedback',
        content: feedbackContent,
        recipient_id: senderId,
        link: '/'
      },
      prisma
    )
  })
  if (typeof failure === 'string') {
    return failure
  }
  await invalidateUnread(senderId).catch(() => undefined)
  return {}
}

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'admin.access',
  input: adminHandleFeedbackSchema,
  handler: ({ input }) => handleFeedback(input)
})
