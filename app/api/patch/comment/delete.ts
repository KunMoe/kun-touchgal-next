import * as z from 'zod'
import { kunId } from '~/validations/primitives'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import {
  executeCommentRemoval,
  planCommentRemoval
} from '~/server/content/comment/remove'
import type { KunActor } from '~/constants/role'
import {
  contentGuard,
  contentSkipMessage,
  decideContentAction
} from '~/utils/content/policy'

const commentIdSchema = z.object({
  commentId: kunId('评论 ID')
})

export const deleteComment = async (
  input: z.infer<typeof commentIdSchema>,
  actor: KunActor
) => {
  const found = await prisma.patch_comment.findUnique({
    where: {
      id: input.commentId
    },
    select: {
      id: true,
      user_id: true,
      status: true
    }
  })
  const decision = decideContentAction('comment', found, actor, 'delete')
  if (!decision.ok) {
    return decision.message
  }
  const comment = decision.row

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏或
  // 被送审的评论不会被作者删掉
  const guard = contentGuard('comment', actor)

  const failure = await kunTx('comment.delete', async (ctx) => {
    const plan = await planCommentRemoval(ctx, [comment.id], guard)
    const [skipped] = plan.skipped
    if (skipped) {
      ctx.fail(contentSkipMessage('comment', 'delete', skipped))
    }
    await executeCommentRemoval(ctx, plan, { orphanReports: 'inline' })
  })
  return failure ?? {}
}
