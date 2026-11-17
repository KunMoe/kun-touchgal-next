import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { COMMENT_STATUS } from '~/constants/contentStatus'
import {
  executeCommentRemoval,
  planCommentRemoval
} from '~/server/content/comment/remove'
import type { CommentRemovalGuard } from '~/server/content/comment/remove'

const commentIdSchema = z.object({
  commentId: z.coerce
    .number({ message: '评论 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

export const deleteComment = async (
  input: z.infer<typeof commentIdSchema>,
  uid: number,
  userRole: number
) => {
  const comment = await prisma.patch_comment.findUnique({
    where: {
      id: input.commentId
    },
    select: {
      id: true,
      user_id: true,
      status: true
    }
  })
  // 隐藏 (status=2) 的评论仅后台可管理, 前端与不存在等同
  if (!comment || comment.status === 2) {
    return '未找到对应的评论'
  }

  if (comment.user_id !== uid && userRole < 3) {
    return '您没有权限删除该评论'
  }
  // 待审核 (status=1) 的评论禁止作者删除; 管理员可删
  if (userRole < 3 && comment.status === 1) {
    return '该评论正在审核中, 暂时无法删除'
  }

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏或
  // 被送审的评论不会被作者删掉
  const guard: CommentRemovalGuard =
    userRole < 3
      ? { statusIn: [COMMENT_STATUS.public], ownerUid: uid }
      : { statusIn: [COMMENT_STATUS.public, COMMENT_STATUS.pending] }

  const failure = await kunTx('comment.delete', async (ctx) => {
    const plan = await planCommentRemoval(ctx, [comment.id], guard)
    const [skipped] = plan.skipped
    if (skipped) {
      ctx.fail(
        skipped.reason === 'owner'
          ? '您没有权限删除该评论'
          : skipped.reason === 'status' &&
              skipped.status === COMMENT_STATUS.pending
            ? '该评论正在审核中, 暂时无法删除'
            : '未找到对应的评论'
      )
    }
    await executeCommentRemoval(ctx, plan, { orphanReports: 'inline' })
  })
  return failure ?? {}
}
