import { prisma } from '~/prisma/index'
import type { KunTx } from '~/prisma/index'
import type { CreateMessageType } from '~/types/api/message'

type MessageClient = KunTx

export const createMessage = async (
  data: CreateMessageType,
  db: MessageClient = prisma
) => {
  const message = await db.user_message.create({
    data
  })
  return message
}

export const createDedupMessage = async (
  data: CreateMessageType,
  db: MessageClient = prisma
) => {
  const duplicatedMessage = await db.user_message.findFirst({
    where: {
      ...data
    }
  })
  if (duplicatedMessage) {
    return
  }

  const message = createMessage(data, db)

  return message
}
