import { z } from 'zod'
import { prisma } from '~/prisma/index'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'
import { cleanupCommentNotifications } from './notifications'
import { collectCommentSubtreeIds } from './subtree'
import { invalidatePatchCommentCache } from './cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'

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
      resource_id: true,
      patch_id: true,
      status: true,
      patch: { select: { unique_id: true } }
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

  await prisma.$transaction(async (tx) => {
    // 删除前一次收集整棵回复子树的 id (根含在内),
    // 供批量清理通知与尚未有最终裁决的审核任务
    const subtreeIds = await collectCommentSubtreeIds([comment.id], tx)

    // 行删除后深链即成死链, 通知须在删除前按 link 清理 (三类口径见 notifications.ts)
    await cleanupCommentNotifications(tx, subtreeIds)

    // parent_id 外键 onDelete: Cascade, 只删根即可带走整棵子树
    await tx.patch_comment.delete({
      where: { id: comment.id }
    })

    await deletePendingModerationTasks('comment', subtreeIds, tx)
    await deletePendingAppeals('comment', subtreeIds, tx)
    await deleteOrphanReports('comment', tx)
  })

  await invalidatePatchCommentCache(comment.patch_id)
  // 删除评论改变 _count.comment, 失效补丁详情缓存 (M-05);
  // 资源评论不计入 _count.comment, 无需失效
  if (!comment.resource_id) {
    await invalidatePatchContentCache(comment.patch.unique_id).catch(
      () => undefined
    )
  }
  return {}
}
