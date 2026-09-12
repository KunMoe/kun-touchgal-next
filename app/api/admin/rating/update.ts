import { z } from 'zod'
import { prisma } from '~/prisma/index'
import { patchRatingUpdateSchema } from '~/validations/admin'

export const updateRating = async (
  input: z.infer<typeof patchRatingUpdateSchema>,
  uid: number
) => {
  const rating = await prisma.patch_rating.findUnique({
    where: { id: input.ratingId }
  })
  if (!rating) {
    return '未找到对应的评价'
  }
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  return await prisma.$transaction(async (prisma) => {
    await prisma.patch_rating.update({
      where: { id: input.ratingId },
      data: {
        short_summary: input.shortSummary
      }
    })

    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: uid,
        content: `管理员 ${admin.name} 更新了一条评价的简评\n原评价: ${JSON.stringify(rating)}`
      }
    })

    return {}
  })
}
