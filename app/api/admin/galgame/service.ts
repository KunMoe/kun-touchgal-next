import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminGalgamePaginationSchema } from '~/validations/admin'
import {
  toPatchWhere,
  type ContentLimit
} from '~/server/viewer/patchVisibility'
import type { AdminGalgame } from '~/types/api/admin'

export const getGalgame = async (
  input: z.infer<typeof adminGalgamePaginationSchema>,
  contentLimit: ContentLimit | null
) => {
  const { page, limit, search } = input
  const offset = (page - 1) * limit
  // 后台列表只按分级过滤, 不套用屏蔽标签
  const nsfwEnable = toPatchWhere({ contentLimit, blockedTagIds: [] })

  const where = search
    ? {
        name: {
          contains: search,
          mode: 'insensitive' as const
        },
        ...nsfwEnable
      }
    : nsfwEnable

  const [data, total] = await Promise.all([
    prisma.patch.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { created: 'desc' },
      select: {
        id: true,
        unique_id: true,
        name: true,
        banner: true,
        created: true,
        user: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        }
      }
    }),
    prisma.patch.count({ where })
  ])

  const galgames: AdminGalgame[] = data.map((galgame) => ({
    id: galgame.id,
    uniqueId: galgame.unique_id,
    name: galgame.name,
    banner: galgame.banner,
    user: galgame.user,
    created: galgame.created
  }))

  return { galgames, total }
}
