import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { createPatchCommentReportSchema } from '~/validations/patch'
import { prisma } from '~/prisma'
import { Prisma } from '~/prisma/generated/prisma/client'

const createReport = async (
  input: z.infer<typeof createPatchCommentReportSchema>,
  uid: number
) => {
  const comment = await prisma.patch_comment.findUnique({
    where: { id: input.commentId },
    select: {
      id: true,
      user_id: true,
      patch_id: true,
      status: true
    }
  })
  if (!comment) {
    return '评论不存在'
  }
  if (comment.patch_id !== input.patchId) {
    return '评论不属于当前游戏'
  }
  if (comment.user_id === uid) {
    return '不能举报自己的评论'
  }
  // 待审核 (status=1) 的评论不可举报; 隐藏 (status=2) 的评论前端不可见, 与不存在等同
  if (comment.status === 1) {
    return '该评论正在审核中, 暂时无法举报'
  }
  if (comment.status !== 0) {
    return '评论不存在'
  }

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
  handler: ({ input, actor }) => createReport(input, actor.uid)
})
