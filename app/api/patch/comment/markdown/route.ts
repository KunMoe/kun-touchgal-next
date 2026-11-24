import * as z from 'zod'
import { kunId } from '~/validations/primitives'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import {
  getCommentRatingVisibilityWhere,
  type KunViewer
} from '~/app/api/utils/contentVisibility'

const commentIdSchema = z.object({
  commentId: kunId('评论 ID')
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
