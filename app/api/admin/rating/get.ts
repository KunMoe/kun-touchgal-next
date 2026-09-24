import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminRatingPaginationSchema } from '~/validations/admin'
import type { AdminRating } from '~/types/api/admin'

export const getRating = async (
  input: z.infer<typeof adminRatingPaginationSchema>
) => {
  const { page, limit, search, searchType, userId } = input
  const offset = (page - 1) * limit
  const normalizedSearch = search?.trim()

  const where = (() => {
    if (searchType === 'user' && userId) {
      return { user_id: userId }
    }

    if (!normalizedSearch) {
      return {}
    }

    return {
      short_summary: {
        contains: normalizedSearch,
        mode: 'insensitive' as const
      }
    }
  })()

  const [data, total] = await Promise.all([
    prisma.patch_rating.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { created: 'desc' },
      include: {
        patch: {
          select: {
            name: true,
            unique_id: true
          }
        },
        user: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        _count: {
          select: {
            like: true
          }
        }
      }
    }),
    prisma.patch_rating.count({ where })
  ])

  const ratings: AdminRating[] = data.map((rating) => ({
    id: rating.id,
    uniqueId: rating.patch.unique_id,
    user: rating.user,
    recommend: rating.recommend,
    overall: rating.overall,
    playStatus: rating.play_status,
    shortSummary: rating.short_summary.slice(0, 233),
    spoilerLevel: rating.spoiler_level,
    patchName: rating.patch.name,
    patchId: rating.patch_id,
    like: rating._count.like,
    status: rating.status,
    created: rating.created
  }))

  return { ratings, total }
}
