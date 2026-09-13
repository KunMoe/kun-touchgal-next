import { z } from 'zod'
import { prisma } from '~/prisma/index'
import { getMessageSchema } from '~/validations/message'
import type { Message } from '~/types/api/message'

export const getMessage = async (
  input: z.infer<typeof getMessageSchema>,
  uid: number
) => {
  const { type, page, limit } = input
  const offset = (page - 1) * limit

  const where = type
    ? { recipient_id: uid, type }
    : {
        recipient_id: uid
        // type: { in: ['like', 'favorite', 'comment', 'pr'] }
      }

  const [data, total] = await Promise.all([
    prisma.user_message.findMany({
      where,
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
    prisma.user_message.count({ where })
  ])

  const messages: Message[] = data.map((msg) => ({
    id: msg.id,
    type: msg.type,
    content: msg.content,
    status: msg.status,
    link: msg.link,
    created: msg.created,
    sender: msg.sender
  }))

  return { messages, total }
}
