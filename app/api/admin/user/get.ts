import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminUserPaginationSchema } from '~/validations/admin'
import type { AdminUser } from '~/types/api/admin'

export const getUserInfo = async (
  input: z.infer<typeof adminUserPaginationSchema>
) => {
  const { page, limit, search, searchType } = input
  const offset = (page - 1) * limit
  const normalizedSearch = search?.trim()

  const where = (() => {
    if (!normalizedSearch) {
      return {}
    }

    if (searchType === 'email') {
      return {
        email: {
          contains: normalizedSearch,
          mode: 'insensitive' as const
        }
      }
    }

    if (searchType === 'id') {
      if (!/^\d+$/.test(normalizedSearch)) {
        return { id: 0 }
      }

      return {
        id: Number.parseInt(normalizedSearch, 10)
      }
    }

    return {
      name: {
        contains: normalizedSearch,
        mode: 'insensitive' as const
      }
    }
  })()

  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { created: 'desc' },
      include: {
        _count: {
          select: {
            patch_resource: true,
            patch: true
          }
        }
      }
    }),
    prisma.user.count({ where })
  ])

  const users: AdminUser[] = data.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    enable2FA: user.enable_2fa,
    bio: user.bio,
    avatar: user.avatar,
    role: user.role,
    created: user.created,
    status: user.status,
    dailyImageCount: user.daily_image_count,
    moemoepoint: user.moemoepoint,
    _count: user._count
  }))

  return { users, total }
}
