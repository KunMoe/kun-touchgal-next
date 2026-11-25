import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { createPatchRatingReportSchema } from '~/validations/patch'
import { prisma } from '~/prisma'
import { decideContentAction } from '~/utils/content/policy'
import type { ContentViewer } from '~/utils/content/policy'

const createReport = async (
  input: z.infer<typeof createPatchRatingReportSchema>,
  viewer: ContentViewer
) => {
  const { uid } = viewer
  const found = await prisma.patch_rating.findUnique({
    where: { id: input.ratingId },
    select: {
      id: true,
      user_id: true,
      patch_id: true,
      status: true
    }
  })
  if (found && found.patch_id !== input.patchId) {
    return '评价不属于当前游戏'
  }
  const decision = decideContentAction('rating', found, viewer, 'report')
  if (!decision.ok) {
    return decision.message
  }
  const rating = decision.row

  const existingReport = await prisma.patch_report.findFirst({
    where: {
      target_type: 'rating',
      rating_id: rating.id,
      sender_id: uid,
      status: 0
    },
    select: { id: true }
  })
  if (existingReport) {
    return '您已经举报过该评价，请等待管理员处理'
  }

  await prisma.patch_report.create({
    data: {
      target_type: 'rating',
      reason: input.content,
      sender_id: uid,
      reported_user_id: rating.user_id,
      patch_id: rating.patch_id,
      rating_id: rating.id
    }
  })

  return {}
}

export const POST = kunRoute.post({
  auth: 'user',
  input: createPatchRatingReportSchema,
  abuse: ['report.create'],
  handler: ({ input, actor }) => createReport(input, actor)
})
