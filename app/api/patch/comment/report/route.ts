import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { createPatchCommentReportSchema } from '~/validations/patch'
import { prisma } from '~/prisma'
import { Prisma } from '~/prisma/generated/prisma/client'
import { decideContentAction } from '~/utils/content/policy'
import type { ContentViewer } from '~/utils/content/policy'

const createReport = async (
  input: z.infer<typeof createPatchCommentReportSchema>,
  viewer: ContentViewer
) => {
  const { uid } = viewer
  const found = await prisma.patch_comment.findUnique({
    where: { id: input.commentId },
    select: {
      id: true,
      user_id: true,
      patch_id: true,
      status: true
    }
  })
  if (found && found.patch_id !== input.patchId) {
    return '评论不属于当前游戏'
  }
  const decision = decideContentAction('comment', found, viewer, 'report')
  if (!decision.ok) {
    return decision.message
  }
  const comment = decision.row

  const existingReport = await prisma.patch_report.findFirst({
    where: {
      target_type: 'comment',
      comment_id: comment.id,
      sender_id: uid,
      status: 0
    },
    select: { id: true }
  })
  if (existingReport) {
    return '您已经举报过该评论，请等待管理员处理'
  }

  try {
    await prisma.patch_report.create({
      data: {
        target_type: 'comment',
        reason: input.content,
        sender_id: uid,
        reported_user_id: comment.user_id,
        patch_id: comment.patch_id,
        comment_id: comment.id
      }
    })
  } catch (error) {
    // 外键命中 = 评论在预检之后被删。删除命令锁着根评论与整棵回复子树, 这次插入要等
    // 它提交, 随后撞外键; 与预检的「评论不存在」同样处理
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    ) {
      return '评论不存在'
    }
    throw error
  }

  return {}
}

export const POST = kunRoute.post({
  auth: 'user',
  input: createPatchCommentReportSchema,
  abuse: ['report.create'],
  handler: ({ input, actor }) => createReport(input, actor)
})
