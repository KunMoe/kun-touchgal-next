import { adminGetFullRatingSchema } from '~/validations/admin'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminGetFullRatingSchema,
  handler: async ({ input }) => {
    const rating = await prisma.patch_rating.findUnique({
      where: { id: input.ratingId },
      select: { short_summary: true }
    })
    if (!rating) {
      return '未找到对应的评价'
    }

    return { shortSummary: rating.short_summary }
  }
})
