import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminDeleteCommentSchema } from '~/validations/admin'
import { kunTx } from '~/server/db/tx'
import {
  executeCommentRemoval,
  planCommentRemoval
} from '~/server/content/comment/remove'
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

  // 后台删除不设守卫: 隐藏、待审的评论都能删
  return kunTx('admin.comment.delete', async (ctx) => {
    const plan = await planCommentRemoval(
      ctx,
      comments.map((comment) => comment.id)
    )
    if (!plan.roots.length) {
      ctx.fail('未找到对应的评论')
    }
    // 级联删除会带走整棵回复子树, 把实际删除的全部 id 返回给调用方
    const { deletedIds } = await executeCommentRemoval(ctx, plan, {
      orphanReports: 'inline'
    })

    // 审计只记锁下实际删掉的根, 不记读取之后已被别人删掉的
    const removedRootIds = new Set(plan.roots.map((root) => root.id))
    await ctx.tx.admin_log.create({
      data: {
        type: 'delete',
        user_id: uid,
        content: buildDeleteLogContent(
          admin.name,
          comments.filter((comment) => removedRootIds.has(comment.id))
        )
      }
    })

    return { deletedIds }
  })
}
