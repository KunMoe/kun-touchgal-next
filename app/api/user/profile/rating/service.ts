import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { getUserInfoSchema } from '~/validations/user'
import {
  getCommentRatingVisibilityWhere,
  type KunViewer
} from '~/app/api/utils/contentVisibility'
import type { UserRating } from '~/types/api/user'
import { PatchRefSelectField } from '~/constants/api/select'

export const getUserPatchRating = async (
  input: z.infer<typeof getUserInfoSchema>,
  viewer: KunViewer
) => {
  const { uid, page, limit } = input
  const offset = (page - 1) * limit
  const visibilityWhere = getCommentRatingVisibilityWhere(viewer)

  const [data, total] = await Promise.all([
    prisma.patch_rating.findMany({
      where: { user_id: uid, ...visibilityWhere },
      include: {
        patch: { select: PatchRefSelectField },
        _count: {
          select: {
            like: true
          }
        }
      },
      orderBy: { created: 'desc' },
      skip: offset,
      take: limit
    }),
    prisma.patch_rating.count({
      where: { user_id: uid, ...visibilityWhere }
    })
  ])

  const ratings: UserRating[] = data.map((rating) => ({
    id: rating.id,
    patchUniqueId: rating.patch.unique_id,
    patchName: rating.patch.name,
    recommend: rating.recommend,
    overall: rating.overall,
    playStatus: rating.play_status,
    shortSummary: rating.short_summary,
    spoilerLevel: rating.spoiler_level,
    like: rating._count.like,
    created: String(rating.created)
  }))

  return { ratings, total }
}
