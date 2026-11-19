import { adminGetFullCommentSchema } from '~/validations/admin'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminGetFullCommentSchema,
  handler: async ({ input }) => {
    const comment = await prisma.patch_comment.findUnique({
      where: { id: input.commentId },
      select: { content: true }
    })
    if (!comment) {
      return '未找到对应的评论'
    }

    return { content: comment.content }
  }
})
