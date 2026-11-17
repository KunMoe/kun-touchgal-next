import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchCommentUpdateSchema } from '~/validations/patch'
import { planTextModeration } from '~/server/moderation/submit'
import { commentSubject } from '~/server/moderation/subject'
import { kunTx } from '~/server/db/tx'
import { editComment } from '~/server/content/comment/edit'
import { prepareCommentContent } from '~/app/api/patch/comment/html'
import { truncateLogContent } from '~/app/api/admin/_log'

const adminUpdateCommentPreviewLimit = 100

export const updateComment = async (
  input: z.infer<typeof patchCommentUpdateSchema>,
  uid: number,
  role: number
) => {
  const comment = await prisma.patch_comment.findUnique({
    where: { id: input.commentId }
  })
  if (!comment) {
    return '未找到对应的评论'
  }
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const { commentId, content } = input

  const prepared = await prepareCommentContent(content)
  if (typeof prepared === 'string') {
    return prepared
  }

  // 送审与否只由操作者的真实角色决定 (超级管理员豁免), 后台入口不另开口子
  const moderation = await planTextModeration(commentSubject(content), {
    userRole: role,
    previous: commentSubject(comment.content)
  })

  // 后台编辑不设守卫: 隐藏、待审的评论都能改; 也不作废在途的审核任务
  return kunTx('admin.comment.update', async (ctx) => {
    const { row } = await editComment(ctx, commentId, {
      data: { ...prepared, edit: Date.now().toString() },
      moderation
    })
    if (!row) {
      ctx.fail('未找到对应的评论')
    }

    // 只记摘要: 整行快照含无上限的 content_html, 序列化后会撑爆
    // admin_log.content 的 VarChar(10007) 并回滚整个更新事务
    const summary = {
      id: comment.id,
      userId: comment.user_id,
      patchId: comment.patch_id,
      parentId: comment.parent_id,
      contentPreview: comment.content.slice(0, adminUpdateCommentPreviewLimit)
    }
    await ctx.tx.admin_log.create({
      data: {
        type: 'update',
        user_id: uid,
        content: truncateLogContent(
          `管理员 ${admin.name} 更新了一条评论的内容\n原评论: ${JSON.stringify(summary)}`
        )
      }
    })
    return {}
  })
}
