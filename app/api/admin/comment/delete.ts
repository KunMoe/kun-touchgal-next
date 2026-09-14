import { z } from 'zod'
import { prisma } from '~/prisma/index'
import { adminDeleteCommentSchema } from '~/validations/admin'
import { collectCommentSubtreeIds } from '~/app/api/patch/comment/subtree'
import { cleanupCommentNotifications } from '~/app/api/patch/comment/notifications'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { deleteOrphanReports } from '~/server/report/pending'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { invalidatePatchContentCacheByPatchId } from '~/app/api/patch/cache'
import { truncateLogContent } from '~/app/api/admin/_log'

const adminDeleteCommentSummaryLimit = 10
const adminDeleteCommentPreviewLimit = 100

const buildDeleteLogContent = (
  adminName: string,
  comments: Array<{
    id: number
    user_id: number
    patch_id: number
    parent_id: number | null
    content: string
  }>
) => {
  const summaries = comments
    .slice(0, adminDeleteCommentSummaryLimit)
    .map((comment) => ({
      id: comment.id,
      userId: comment.user_id,
      patchId: comment.patch_id,
      parentId: comment.parent_id,
      contentPreview: comment.content.slice(0, adminDeleteCommentPreviewLimit)
    }))

  const suffix =
    comments.length > summaries.length
      ? `\n其余 ${comments.length - summaries.length} 条评论摘要已省略`
      : ''

  const content =
    comments.length > 1
      ? `管理员 ${adminName} 批量删除了 ${comments.length} 条评论\n评论 ID: ${comments
          .map((comment) => comment.id)
          .join(', ')}\n评论摘要: ${JSON.stringify(summaries)}${suffix}`
      : `管理员 ${adminName} 删除了一条评论\n评论详情: ${JSON.stringify(summaries[0])}`

  return truncateLogContent(content)
}

export const deleteComment = async (
  input: z.infer<typeof adminDeleteCommentSchema>,
  uid: number
) => {
  const comments = await prisma.patch_comment.findMany({
    where: {
      id: {
        in: input.commentIds
      }
    }
  })
  if (!comments.length) {
    return '未找到对应的评论'
  }

  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const patchIds = [...new Set(comments.map((comment) => comment.patch_id))]

  // 级联删除会带走整棵回复子树, 把实际删除的全部 id 返回给调用方
  let deletedIds: number[] = []
  await prisma.$transaction(async (prisma) => {
    const targetIds = comments.map((comment) => comment.id)

    // 级联删除会带走整棵回复子树, 删除前先收集全部后代 id
    // 以清理它们尚未有最终裁决的审核任务
    deletedIds = await collectCommentSubtreeIds(targetIds, prisma)

    // 行删除后深链即成死链, 通知须在删除前按 link 清理 (三类口径见 notifications.ts)
    await cleanupCommentNotifications(prisma, deletedIds)

    await prisma.patch_comment.deleteMany({
      where: {
        id: {
          in: targetIds
        }
      }
    })

    await deletePendingModerationTasks('comment', deletedIds, prisma)

    await deletePendingAppeals('comment', deletedIds, prisma)

    await deleteOrphanReports('comment', prisma)

    await prisma.admin_log.create({
      data: {
        type: 'delete',
        user_id: uid,
        content: buildDeleteLogContent(admin.name, comments)
      }
    })
  })

  await Promise.all(
    patchIds.map((patchId) => invalidatePatchCommentCache(patchId))
  )
  // 批量删除评论改变 _count.comment, 失效补丁详情缓存 (M-05)
  await invalidatePatchContentCacheByPatchId(patchIds).catch(() => undefined)

  return { deletedIds }
}
