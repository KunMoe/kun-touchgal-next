import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import {
  getCommentRatingVisibilityWhere,
  type KunViewer
} from '~/app/api/utils/contentVisibility'

const commentIdSchema = z.object({
  commentId: z.coerce
    .number({ message: '评论 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

const getCommentMarkdown = async (
  input: z.infer<typeof commentIdSchema>,
  viewer: KunViewer
) => {
  const { commentId } = input

  const comment = await prisma.patch_comment.findFirst({
    where: { id: commentId, ...getCommentRatingVisibilityWhere(viewer) },
    select: {
      content: true,
      is_spoiler: true
    }
  })

  return {
    content: comment?.content ?? '',
    isSpoiler: comment?.is_spoiler ?? false
  }
}

export const GET = kunRoute.get({
  auth: 'user',
  input: commentIdSchema,
  handler: ({ input, actor }) => getCommentMarkdown(input, actor)
})
