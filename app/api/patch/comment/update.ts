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
import { editComment } from '~/server/content/comment/edit'
import { prepareCommentContent } from './html'
import type { KunActor } from '~/constants/role'
import {
  contentGuard,
  contentSkipMessage,
  decideContentAction,
  pendingTaskBlocks,
  isCommentContainerVisible
} from '~/utils/content/policy'

export const updateComment = async (
  input: z.infer<typeof patchCommentUpdateSchema>,
  actor: KunActor
) => {
  const { commentId, content, isSpoiler } = input

  const found = await prisma.patch_comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      user_id: true,
      status: true,
      content: true,
      resource: { select: { status: true, user_id: true } }
    }
  })
  const pendingTask =
    !!found &&
    pendingTaskBlocks(actor) &&
    (await hasPendingModeration('comment', { contentId: commentId }))
  const decision = decideContentAction('comment', found, actor, 'edit', {
    pendingTask,
    containerVisible: isCommentContainerVisible(found?.resource, actor)
  })
  if (!decision.ok) {
    return decision.message
  }
  const comment = decision.row

  const prepared = await prepareCommentContent(content)
  if (typeof prepared === 'string') {
    return prepared
  }

  // 编辑正文后必须重新送审, 否则先发正常内容再改成违规即可绕过审核
  const moderation = await planTextModeration(commentSubject(content), {
    actor,
    previous: commentSubject(comment.content)
  })
  if (typeof moderation === 'string') {
    return moderation
  }

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏的
  // 评论不会被这次编辑写回待审核
  const guard = contentGuard('comment', actor)

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
      ctx.fail(contentSkipMessage('comment', 'edit', skipped))
    }
  })
  if (typeof result === 'string') {
    return result
  }

  return {
    contentHtml: prepared.content_html,
    contentPreview: convert(prepared.content_html).trim()
  }
}
