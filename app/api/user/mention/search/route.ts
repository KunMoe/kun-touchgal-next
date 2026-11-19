import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { searchUserSchema } from '~/validations/user'

const searchUser = async (input: z.infer<typeof searchUserSchema>) => {
  const { query } = input

  const users: KunUser[] = await prisma.user.findMany({
    where: {
      name: { contains: query, mode: 'insensitive' }
    },
    select: {
      id: true,
      name: true,
      avatar: true
    },
    take: 10
  })

  return users
}

export const GET = kunRoute.get({
  auth: 'user',
  input: searchUserSchema,
  handler: async ({ input }) => searchUser(input)
})
