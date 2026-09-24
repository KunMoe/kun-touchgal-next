import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchCommentUpdateSchema } from '~/validations/patch'
import {
  COMMENT_HTML_VERSION,
  markdownToHtmlComment
} from '~/app/api/utils/render/markdownToHtmlComment'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { truncateLogContent } from '~/app/api/admin/_log'

const adminUpdateCommentPreviewLimit = 100

export const updateComment = async (
  input: z.infer<typeof patchCommentUpdateSchema>,
  uid: number
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

  let contentHtml = ''
  let contentHtmlVersion = 0
  try {
    contentHtml = await markdownToHtmlComment(content)
    contentHtmlVersion = COMMENT_HTML_VERSION
  } catch {
    contentHtml = ''
    contentHtmlVersion = 0
  }

  await prisma.$transaction(async (prisma) => {
    await prisma.patch_comment.update({
      where: { id: commentId },
      data: {
        content,
        content_html: contentHtml,
        content_html_version: contentHtmlVersion,
        edit: Date.now().toString()
      }
    })

    // 只记摘要: 整行快照含无上限的 content_html, 序列化后会撑爆
    // admin_log.content 的 VarChar(10007) 并回滚整个更新事务
    const summary = {
      id: comment.id,
      userId: comment.user_id,
      patchId: comment.patch_id,
      parentId: comment.parent_id,
      contentPreview: comment.content.slice(0, adminUpdateCommentPreviewLimit)
    }
    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: uid,
        content: truncateLogContent(
          `管理员 ${admin.name} 更新了一条评论的内容\n原评论: ${JSON.stringify(summary)}`
        )
      }
    })
  })

  await invalidatePatchCommentCache(comment.patch_id)
  return {}
}
