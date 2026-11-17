import { COMMENT_STATUS } from '~/constants/contentStatus'
import { enqueueTextModeration } from '~/server/moderation/submit'
import { recordContentChanges } from '~/server/content/changes'
import { applyContentGuard } from '~/server/content/guard'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { CommentStatus } from '~/constants/contentStatus'
import type { ContentGuard } from '~/server/content/guard'
import type { ModerationPlan } from '~/server/moderation/submit'
import type { KunTxContext } from '~/server/db/tx'

// 评论的编辑。锁行 → 行锁下判守卫 → 写入 → (需要时) 入审核队列。
// 守卫在锁下判定: 入口事务外读到的快照与写入之间, 评论可能已被管理员隐藏; 不复检的话
// 被拦截的编辑会把隐藏的评论写回待审核, 审核一放行就悄悄撤销了管理员的隐藏
export const editComment = async (
  ctx: KunTxContext,
  commentId: number,
  options: {
    // 不传即不设条件 (后台编辑)
    guard?: ContentGuard<CommentStatus>
    data: Omit<Prisma.patch_commentUpdateManyMutationInput, 'status'>
    // 入口在事务外算好的送审计划: 读审核配置可能因 Redis 故障抛错, 不放进事务。
    // 被拦截 (intercept) 的编辑把评论转为待审核, 等裁决落定
    moderation: ModerationPlan<'comment'>
  }
) => {
  const { tx } = ctx
  const locked = await tx.$queryRaw<
    Array<{
      id: number
      user_id: number
      patch_id: number
      resource_id: number | null
      status: CommentStatus
    }>
  >`
    SELECT id, user_id, patch_id, resource_id, status
    FROM patch_comment
    WHERE id = ${commentId}
    FOR UPDATE`
  const {
    passed: [row],
    skipped: [skipped]
  } = applyContentGuard([commentId], locked, options.guard)
  if (!row) {
    return { row: undefined, skipped }
  }

  const after = options.moderation.intercept
    ? COMMENT_STATUS.pending
    : row.status
  await tx.patch_comment.updateMany({
    where: { id: commentId },
    data: { ...options.data, status: after }
  })
  if (options.moderation.queue) {
    await enqueueTextModeration(tx, options.moderation, {
      contentId: commentId,
      userId: row.user_id
    })
  }

  recordContentChanges(ctx, [
    {
      kind: 'comment',
      id: row.id,
      patchId: row.patch_id,
      resourceId: row.resource_id,
      before: row.status,
      after
    }
  ])
  return { row, skipped: undefined }
}
