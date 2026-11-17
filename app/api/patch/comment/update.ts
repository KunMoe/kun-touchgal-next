import * as z from 'zod'
import { convert } from 'html-to-text'
import { prisma } from '~/prisma/index'
import { patchCommentUpdateSchema } from '~/validations/patch'
import {
  hasPendingModeration,
  planTextModeration
} from '~/server/moderation/submit'
import { commentSubject } from '~/server/moderation/subject'
import { kunTx } from '~/server/db/tx'
import { COMMENT_STATUS } from '~/constants/contentStatus'
import { editComment } from '~/server/content/comment/edit'
import { prepareCommentContent } from './html'
import type { CommentStatus } from '~/constants/contentStatus'
import type { ContentGuard } from '~/server/content/guard'

export const updateComment = async (
  input: z.infer<typeof patchCommentUpdateSchema>,
  uid: number,
  userRole: number
) => {
  const { commentId, content, isSpoiler } = input

  const comment = await prisma.patch_comment.findUnique({
    where: { id: commentId },
    select: { id: true, user_id: true, status: true, content: true }
  })
  // 隐藏 (status=2) 的评论仅后台可管理, 前端与不存在等同
  if (!comment || comment.status === 2) {
    return '未找到该评论'
  }
  if (comment.user_id !== uid && userRole < 3) {
    return '您没有权限更改该评论'
  }
  if (
    userRole < 3 &&
    (await hasPendingModeration('comment', { contentId: commentId }))
  ) {
    return '您发布的评论正在审核中, 暂时无法修改'
  }
  // 待审核 (status=1) 的评论禁止修改; hasPendingModeration 之外再兜底一层
  if (userRole < 3 && comment.status === 1) {
    return '您发布的评论正在审核中, 暂时无法修改'
  }

  const prepared = await prepareCommentContent(content)
  if (typeof prepared === 'string') {
    return prepared
  }

  // 编辑正文后必须重新送审, 否则先发正常内容再改成违规即可绕过审核
  const moderation = await planTextModeration(commentSubject(content), {
    userRole,
    previous: commentSubject(comment.content)
  })

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏的
  // 评论不会被这次编辑写回待审核
  const guard: ContentGuard<CommentStatus> =
    userRole < 3
      ? { statusIn: [COMMENT_STATUS.public], ownerUid: uid }
      : { statusIn: [COMMENT_STATUS.public, COMMENT_STATUS.pending] }

  const result = await kunTx('comment.update', async (ctx) => {
    const { skipped } = await editComment(ctx, commentId, {
      guard,
      data: {
        ...prepared,
        is_spoiler: isSpoiler,
        edit: Date.now().toString()
      },
      moderation
    })
    if (skipped) {
      ctx.fail(
        skipped.reason === 'owner'
          ? '您没有权限更改该评论'
          : skipped.reason === 'status' &&
              skipped.status === COMMENT_STATUS.pending
            ? '您发布的评论正在审核中, 暂时无法修改'
            : '未找到该评论'
      )
    }
    return {}
  })
  if (typeof result === 'string') {
    return result
  }

  return {
    contentHtml: prepared.content_html,
    contentPreview: convert(prepared.content_html).trim()
  }
}
