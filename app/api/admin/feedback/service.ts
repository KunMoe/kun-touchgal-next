import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminFeedbackPaginationSchema } from '~/validations/admin'
import type { Message } from '~/types/api/message'

export const getFeedback = async (
  input: z.infer<typeof adminFeedbackPaginationSchema>
) => {
  const { page, limit } = input
  const offset = (page - 1) * limit

  const [data, total] = await Promise.all([
    prisma.user_message.findMany({
      where: { type: 'feedback', sender_id: { not: null } },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        }
      },
      orderBy: [{ created: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit
    }),
    prisma.user_message.count({
      where: { type: 'feedback', sender_id: { not: null } }
    })
  ])

  const feedbacks: Message[] = data.map((msg) => ({
    id: msg.id,
    type: msg.type,
    content: msg.content,
    status: msg.status,
    link: msg.link,
    created: msg.created,
    sender: msg.sender
  }))

  return { feedbacks, total }
}
