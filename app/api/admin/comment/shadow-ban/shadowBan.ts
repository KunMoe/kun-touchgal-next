import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { COMMENT_STATUS } from '~/constants/contentStatus'
import { transitionComments } from '~/server/content/comment/transition'
import { adminUpdateCommentShadowBanSchema } from '~/validations/admin'

const statusLabel: Record<number, string> = {
  0: '正常',
  1: '待审核',
  2: '隐藏'
}

export const updateCommentShadowBan = async (
  input: z.infer<typeof adminUpdateCommentShadowBanSchema>,
  adminUid: number
) => {
  const admin = await prisma.user.findUnique({ where: { id: adminUid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const { commentId, status } = input

  const comment = await prisma.patch_comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      status: true,
      user: { select: { name: true } }
    }
  })
  if (!comment) {
    return '未找到该评论'
  }
  if (comment.status === status) {
    return `该评论已处于${statusLabel[status]}状态`
  }

  const failure = await kunTx('admin.comment.shadowBan', async (ctx) => {
    // 管理员的裁决是最终的, 在途的审核任务一并作废 (dry_run 评估保留)。恢复为正常时,
    // 创建时被拦截而没发出的通知由命令在提交后补发
    const [moved] = await transitionComments(ctx, [commentId], {
      from: Object.values(COMMENT_STATUS).filter((value) => value !== status),
      to: status,
      openTasks: 'cancel-keep-dry-run'
    })
    // 上面判的是事务外快照; 行锁下已是目标状态, 或已被删除
    if (!moved) {
      const exists = await ctx.tx.patch_comment.findUnique({
        where: { id: commentId },
        select: { id: true }
      })
      return ctx.fail(
        exists ? `该评论已处于${statusLabel[status]}状态` : '未找到该评论'
      )
    }

    await ctx.tx.admin_log.create({
      data: {
        type: 'update',
        user_id: adminUid,
        content: `管理员 ${admin.name} 将用户 ${comment.user.name} 的评论 (ID: ${commentId}) 状态由 ${statusLabel[moved.from]} 修改为 ${statusLabel[status]}`
      }
    })
  })
  return failure ?? {}
}
