import * as z from 'zod'
import { prisma } from '~/prisma/index'
import {
  getCommentRatingVisibilityWhere,
  type KunViewer
} from '~/app/api/utils/contentVisibility'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { KunPatchRating } from '~/types/api/galgame'

export const getPatchRatingSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999),
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(50),
  targetRatingId: z.coerce.number().min(1).max(9999999).optional(),
  onlyWithShortSummary: z
    .enum(['false', 'true'])
    .optional()
    .transform((value) => value === 'true')
})

export const getPatchRating = async (
  input: z.infer<typeof getPatchRatingSchema>,
  viewer: KunViewer
) => {
  const { patchId, page, limit, targetRatingId, onlyWithShortSummary } = input
  const uid = viewer.uid
  const where: Prisma.patch_ratingWhereInput = {
    patch_id: patchId,
    AND: [
      getCommentRatingVisibilityWhere(viewer),
      ...(onlyWithShortSummary
        ? [
            {
              OR: [
                { short_summary: { not: '' } },
                ...(targetRatingId ? [{ id: targetRatingId }] : [])
              ]
            }
          ]
        : [])
    ]
  }

  const [data, total] = await Promise.all([
    prisma.patch_rating.findMany({
      where,
      orderBy: { created: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        patch: { select: { unique_id: true } },
        user: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        _count: {
          select: { like: true }
        },
        like: {
          where: {
            user_id: uid
          }
        }
      }
    }),
    prisma.patch_rating.count({
      where
    })
  ])

  const ratings: KunPatchRating[] = data.map((rating) => ({
    id: rating.id,
    uniqueId: rating.patch.unique_id,
    recommend: rating.recommend,
    overall: rating.overall,
    playStatus: rating.play_status,
    shortSummary: rating.short_summary,
    spoilerLevel: rating.spoiler_level,
    status: rating.status,
    isLike: rating.like.length > 0,
    likeCount: rating._count.like,
    userId: rating.user_id,
    patchId: rating.patch_id,
    created: rating.created,
    updated: rating.updated,
    user: {
      id: rating.user.id,
      name: rating.user.name,
      avatar: rating.user.avatar
    }
  }))

  return { ratings, total }
}
