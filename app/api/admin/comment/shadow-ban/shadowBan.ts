import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminUpdateCommentShadowBanSchema } from '~/validations/admin'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { invalidatePatchContentCacheByPatchId } from '~/app/api/patch/cache'

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
      patch_id: true,
      user: { select: { name: true } }
    }
  })
  if (!comment) {
    return '未找到该评论'
  }
  if (comment.status === status) {
    return `该评论已处于${statusLabel[status]}状态`
  }

  await prisma.$transaction(async (prisma) => {
    // 先作废在途审核任务再改 status: 锁顺序 (task→内容行) 与 worker apply 对齐,
    // 消除与 worker 的 AB-BA 死锁; 管理员裁决为最终, 在途裁决不应再覆盖.
    // (作者编辑路径锁序相反, 但非特权作者被 hasPendingModeration 挡在事务外)
    // 传 excludeDryRun=true: 内容仍在, 保留不改内容的 dry_run 评估任务
    await deletePendingModerationTasks('comment', commentId, prisma, true)

    await prisma.patch_comment.update({
      where: { id: commentId },
      data: { status }
    })

    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: adminUid,
        content: `管理员 ${admin.name} 将用户 ${comment.user.name} 的评论 (ID: ${commentId}) 状态由 ${statusLabel[comment.status]} 修改为 ${statusLabel[status]}`
      }
    })
  })

  await invalidatePatchCommentCache(comment.patch_id)
  // 隐藏/恢复评论改变 _count.comment, 失效补丁详情缓存 (M-05)
  await invalidatePatchContentCacheByPatchId(comment.patch_id).catch(
    () => undefined
  )
  return {}
}
