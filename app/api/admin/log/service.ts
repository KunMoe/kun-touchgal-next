import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminPaginationSchema } from '~/validations/admin'
import type { AdminLog } from '~/types/api/admin'

export const getLog = async (input: z.infer<typeof adminPaginationSchema>) => {
  const { page, limit } = input
  const offset = (page - 1) * limit

  const [data, total] = await Promise.all([
    prisma.admin_log.findMany({
      take: limit,
      skip: offset,
      orderBy: { created: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        }
      }
    }),
    prisma.admin_log.count()
  ])

  const logs: AdminLog[] = data.map((log) => ({
    id: log.id,
    type: log.type,
    user: log.user,
    content: log.content,
    created: log.created
  }))

  return { logs, total }
}
