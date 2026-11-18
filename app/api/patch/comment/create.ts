import * as z from 'zod'
import { convert } from 'html-to-text'
import { prisma } from '~/prisma/index'
import { patchCommentCreateSchema } from '~/validations/patch'
import {
  enqueueTextModeration,
  planTextModeration
} from '~/server/moderation/submit'
import { commentSubject } from '~/server/moderation/subject'
import { onCommentPublished } from '~/server/content/comment/publish'
import { kunTx } from '~/server/db/tx'
import { getResourceVisibilityWhere } from '~/app/api/utils/contentVisibility'
import { invalidatePatchCommentCache } from './cache'
import { prepareCommentContent } from './html'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import type { PatchComment } from '~/types/api/patch'
import type { KunActor } from '~/constants/role'

// 待审核 (status=1) 的评论不可回复; 隐藏 (status=2) 的评论前端不可见, 与不存在等同
const replyParentError = (parent: { status: number } | null | undefined) => {
  if (!parent) {
    return '未找到该评论'
  }
  if (parent.status === 1) {
    return '该评论正在审核中, 暂时无法回复'
  }
  if (parent.status !== 0) {
    return '未找到该评论'
  }
  return null
}

export const createPatchComment = async (
  input: z.infer<typeof patchCommentCreateSchema>,
  actor: KunActor
) => {
  const { uid } = actor
  let parentComment: { status: number; resource_id: number | null } | null =
    null
  if (input.parentId) {
    // patch_id 同查: 防跨补丁回复造出 patch_id 与 resource_id 互相矛盾的评论
    parentComment = await prisma.patch_comment.findFirst({
      where: { id: input.parentId, patch_id: input.patchId },
      select: { status: true, resource_id: true }
    })
    const parentError = replyParentError(parentComment)
    if (parentError) {
      return parentError
    }
  }

  // 回复以父评论的 resource_id 为准, 忽略 body (防伪造把回复搬进/搬出资源评论区)
  const resourceId = input.parentId
    ? (parentComment?.resource_id ?? null)
    : (input.resourceId ?? null)
  // 顶层与回复都校验资源属于该 patch 且对评论者可见 (资源被隐藏后评论区随之关闭)
  if (resourceId) {
    const resource = await prisma.patch_resource.findFirst({
      where: {
        id: resourceId,
        patch_id: input.patchId,
        ...getResourceVisibilityWhere(actor)
      },
      select: { id: true }
    })
    if (!resource) {
      return '未找到该资源'
    }
  }

  const [prepared, moderation] = await Promise.all([
    prepareCommentContent(input.content),
    planTextModeration(commentSubject(input.content), { actor })
  ])
  if (typeof prepared === 'string') {
    return prepared
  }

  const data = await kunTx('comment.create', async (ctx) => {
    const { tx } = ctx
    // 事务外的预检之后, 资源或父评论可能被删、被隐藏。删除与隐藏的命令锁着这些行
    // (FOR UPDATE): 插入之前先取 FOR KEY SHARE, 排在它们之后就读到提交后的结果, 当场
    // 给出与预检相同的提示; 不取的话要等 INSERT 的外键检查才失败, 调用方看到的是 500。
    // 顺序与级联删除一致 (资源 → 补丁 → 评论): 先锁父评论的话, 删资源的事务锁着资源行
    // 去级联删评论, 这里锁着评论行去等资源行, 两边互等
    if (resourceId) {
      const resources = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM patch_resource WHERE id = ${resourceId} FOR KEY SHARE`
      if (!resources.length) {
        ctx.fail('未找到该资源')
      }
    }
    if (input.parentId) {
      // 补丁被整体删除时父评论随之消失, 由下面的父评论检查给出结果
      await tx.$executeRaw`SELECT id FROM patch WHERE id = ${input.patchId} FOR KEY SHARE`
      const [parent] = await tx.$queryRaw<Array<{ status: number }>>`
        SELECT status FROM patch_comment WHERE id = ${input.parentId} FOR KEY SHARE`
      const parentError = replyParentError(parent)
      if (parentError) {
        ctx.fail(parentError)
      }
    }

    const created = await tx.patch_comment.create({
      data: {
        ...prepared,
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
            unique_id: true
          }
        }
      }
    })

    if (moderation.queue) {
      await enqueueTextModeration(tx, moderation, {
        contentId: created.id,
        userId: uid
      })
    }

    return created
  })
  if (typeof data === 'string') {
    return data
  }

  const newComment: Omit<PatchComment, 'user'> = {
    id: data.id,
    uniqueId: data.patch?.unique_id ?? '',
    content: prepared.content_html,
    contentPreview: convert(prepared.content_html).trim(),
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

  // 缓存先、通知后。被审核拦截的评论不发通知, 等它对他人可见时
  // (审核通过 / 申诉通过 / 管理员恢复) 再由同一个入口补发
  if (!moderation.intercept) {
    await onCommentPublished(data.id)
  }

  return newComment
}
