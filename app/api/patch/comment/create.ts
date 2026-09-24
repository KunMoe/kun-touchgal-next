import * as z from 'zod'
import { convert } from 'html-to-text'
import { prisma } from '~/prisma/index'
import { patchCommentCreateSchema } from '~/validations/patch'
import {
  createDedupMessage,
  createLinkDedupMessage
} from '~/app/api/utils/message'
import { createMentionMessage } from '~/app/api/utils/createMentionMessage'
import {
  COMMENT_HTML_VERSION,
  markdownToHtmlComment
} from '~/app/api/utils/render/markdownToHtmlComment'
import { createModerationTask, preScreenText } from '~/server/moderation/submit'
import { getResourceVisibilityWhere } from '~/app/api/utils/contentVisibility'
import { buildCommentLink } from '~/utils/patch/buildCommentLink'
import { invalidatePatchCommentCache } from './cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import type { PatchComment } from '~/types/api/patch'

export const createPatchComment = async (
  input: z.infer<typeof patchCommentCreateSchema>,
  uid: number,
  userRole: number
) => {
  let parentComment: {
    user_id: number
    content: string
    status: number
    resource_id: number | null
  } | null = null
  if (input.parentId) {
    // patch_id 同查: 防跨补丁回复造出 patch_id 与 resource_id 互相矛盾的评论
    parentComment = await prisma.patch_comment.findFirst({
      where: { id: input.parentId, patch_id: input.patchId },
      select: { user_id: true, content: true, status: true, resource_id: true }
    })
    if (!parentComment) {
      return '未找到该评论'
    }
    // 待审核 (status=1) 的评论不可回复; 隐藏 (status=2) 的评论前端不可见, 与不存在等同
    if (parentComment.status === 1) {
      return '该评论正在审核中, 暂时无法回复'
    }
    if (parentComment.status !== 0) {
      return '未找到该评论'
    }
  }

  // 回复以父评论的 resource_id 为准, 忽略 body (防伪造把回复搬进/搬出资源评论区)
  const resourceId = input.parentId
    ? (parentComment?.resource_id ?? null)
    : (input.resourceId ?? null)
  // 顶层与回复都校验资源属于该 patch 且对评论者可见 (资源被隐藏后评论区随之关闭)
  let resourceUploaderUid: number | null = null
  if (resourceId) {
    const resource = await prisma.patch_resource.findFirst({
      where: {
        id: resourceId,
        patch_id: input.patchId,
        ...getResourceVisibilityWhere({ uid, role: userRole })
      },
      select: { user_id: true }
    })
    if (!resource) {
      return '未找到该资源'
    }
    resourceUploaderUid = resource.user_id
  }

  const [contentResult, moderation] = await Promise.all([
    (async () => {
      try {
        return {
          html: await markdownToHtmlComment(input.content),
          version: COMMENT_HTML_VERSION
        }
      } catch {
        return { html: '', version: 0 }
      }
    })(),
    preScreenText(input.content, userRole)
  ])
  const { html: contentHtml, version: contentHtmlVersion } = contentResult

  const data = await prisma.$transaction(async (tx) => {
    const created = await tx.patch_comment.create({
      data: {
        content: input.content,
        content_html: contentHtml,
        content_html_version: contentHtmlVersion,
        is_spoiler: input.isSpoiler,
        status: moderation.intercept ? 1 : 0,
        user_id: uid,
        patch_id: input.patchId,
        parent_id: input.parentId,
        resource_id: resourceId
      },
      include: {
        patch: {
          select: {
            name: true,
            unique_id: true
          }
        },
        user: {
          select: {
            name: true
          }
        }
      }
    })

    if (moderation.queue) {
      await createModerationTask(
        {
          contentType: 'comment',
          contentId: created.id,
          userId: uid,
          payload: { text: input.content },
          dryRun: moderation.dryRun
        },
        tx
      )
    }

    return created
  })

  // 拦截时通知由 apply.ts 在审核通过后补发 (文案须与该处逐字一致以保去重命中);
  // 通知在事务外自动提交, 紧随其后失效收件人未读缓存即为提交后失效 (L-01)
  if (!moderation.intercept) {
    if (parentComment && parentComment.user_id !== uid) {
      await createDedupMessage({
        type: 'comment',
        content: `回复了您的评论：${parentComment.content.slice(0, 107)}`,
        sender_id: uid,
        recipient_id: parentComment.user_id,
        link: buildCommentLink(data.patch.unique_id, data.id, resourceId)
      })
      await invalidateUnread(parentComment.user_id).catch(() => undefined)
    }

    // 资源的一级评论通知资源上传者 (自评自己上传的资源不通知);
    // link 维度去重: 评论编辑重审通过后 content 会变, 不能进去重键
    if (
      !input.parentId &&
      resourceId &&
      resourceUploaderUid !== null &&
      resourceUploaderUid !== uid
    ) {
      await createLinkDedupMessage({
        type: 'comment',
        content: `评论了您发布的资源：${input.content.slice(0, 107)}`,
        sender_id: uid,
        recipient_id: resourceUploaderUid,
        link: buildCommentLink(data.patch.unique_id, data.id, resourceId)
      })
      await invalidateUnread(resourceUploaderUid).catch(() => undefined)
    }

    await createMentionMessage(
      data.patch.unique_id,
      data.patch.name,
      data.id,
      uid,
      data.user.name,
      input.content,
      resourceId
    )
  }

  const renderedHtml =
    contentHtmlVersion === COMMENT_HTML_VERSION && contentHtml
      ? contentHtml
      : await markdownToHtmlComment(data.content)

  const newComment: Omit<PatchComment, 'user'> = {
    id: data.id,
    uniqueId: data.patch?.unique_id ?? '',
    content: renderedHtml,
    contentPreview: convert(renderedHtml).trim(),
    isLike: false,
    isSpoiler: data.is_spoiler,
    status: data.status,
    likeCount: 0,
    parentId: data.parent_id,
    replyToId: data.parent_id,
    userId: data.user_id,
    patchId: data.patch_id,
    reply: [],
    created: String(data.created),
    updated: String(data.updated)
  }

  await invalidatePatchCommentCache(input.patchId)
  // 新增评论改变 _count.comment, 失效补丁详情缓存 (M-05);
  // 资源评论不计入 _count.comment, 无需失效
  if (!resourceId) {
    await invalidatePatchContentCache(data.patch.unique_id).catch(
      () => undefined
    )
  }

  return newComment
}
