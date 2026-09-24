import * as z from 'zod'
import { convert } from 'html-to-text'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import {
  COMMENT_HTML_VERSION,
  markdownToHtmlComment
} from '~/app/api/utils/render/markdownToHtmlComment'
import { getPatchCommentSchema } from '~/validations/patch'
import {
  getCommentRatingVisibilityWhere,
  getCommentVisibilitySql,
  type KunViewer
} from '~/app/api/utils/contentVisibility'
import { withPatchCommentPageCache } from './cache'
import type { PatchComment } from '~/types/api/patch'

// 共享缓存基线视角: status=0 公开可见, isLike 一律 false
const PUBLIC_VIEWER: KunViewer = { uid: 0, role: 0 }

type CommentLocator = {
  id: number
  patch_id: number
  parent_id: number | null
  resource_id: number | null
  created: Date
}

// 管理员可见他人待审核内容, 有自己待审 (status=1) 评论的用户可见自己的待审,
// 两者响应都不同于公开基线, 必须绕过共享缓存走完整视角
const shouldBypassCommentCache = async (patchId: number, viewer: KunViewer) => {
  if (viewer.role >= 3) {
    return true
  }
  if (viewer.uid <= 0) {
    return false
  }

  const pendingCount = await prisma.patch_comment.count({
    where: { patch_id: patchId, user_id: viewer.uid, status: 1 }
  })
  return pendingCount > 0
}

// 深链定位: 找到目标评论所属的根评论并换算其所在页
const resolveCurrentPage = async (
  input: z.infer<typeof getPatchCommentSchema>,
  viewer: KunViewer
) => {
  const { patchId, page, limit, commentId } = input
  const resourceId = input.resourceId ?? null
  if (!commentId) {
    return page
  }

  const visibilitySql = getCommentVisibilitySql(viewer)
  const rows = await prisma.$queryRaw<CommentLocator[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, patch_id, parent_id, resource_id, created
      FROM patch_comment
      WHERE id = ${commentId} AND patch_id = ${patchId}
        AND ${visibilitySql}
      UNION ALL
      SELECT pc.id, pc.patch_id, pc.parent_id, pc.resource_id, pc.created
      FROM patch_comment pc
      INNER JOIN ancestors a ON pc.id = a.parent_id
      WHERE pc.patch_id = ${patchId} AND ${visibilitySql}
    )
    SELECT id, patch_id, parent_id, resource_id, created
    FROM ancestors
    WHERE parent_id IS NULL
    LIMIT 1
  `
  const rootComment = rows[0] ?? null
  if (!rootComment) {
    return page
  }
  // 目标评论不属于请求的评论区 (patch 评论区 vs 某资源评论区):
  // 直接返回请求页, 避免把跨上下文页码写入共享分页缓存
  if ((rootComment.resource_id ?? null) !== resourceId) {
    return page
  }

  const commentsBeforeTargetRoot = await prisma.patch_comment.count({
    where: {
      patch_id: patchId,
      parent_id: null,
      resource_id: resourceId,
      AND: [
        getCommentRatingVisibilityWhere(viewer),
        {
          OR: [
            { created: { gt: rootComment.created } },
            {
              AND: [
                { created: rootComment.created },
                { id: { gt: rootComment.id } }
              ]
            }
          ]
        }
      ]
    }
  })

  return Math.floor(commentsBeforeTargetRoot / limit) + 1
}

// 回落渲染后就地写回, 使版本过期的历史评论收敛到 content_html 快路径,
// 缩短 COMMENT_HTML_VERSION 递增到 backfill 跑完之间的重复渲染窗口。
// CAS 条件 (content_html_version != CURRENT + updated) 的两道防线:
//   1. 版本条件: 已被 backfill/其他请求更新到当前版本的行不会再次覆盖 (避免并发自愈重写)
//   2. updated 条件: 评论内容被修改过则不覆盖 (避免旧内容的渲染结果误写入新内容记录)
// 写回失败不影响本次响应, 下次请求幂等重试。
const persistStaleCommentHtml = async (
  renders: { id: number; html: string; updated: Date }[]
) => {
  // 逐条 autocommit 而非单个 $transaction: 各行自愈写相互独立、无原子性需求,
  // 提交即释放行锁且单条失败不牵连其他, 对齐 flushPatchViewsTask 的 autocommit 约定
  for (const { id, html, updated } of renders) {
    try {
      await prisma.patch_comment.updateMany({
        where: {
          id,
          content_html_version: { not: COMMENT_HTML_VERSION },
          updated
        },
        data: {
          content_html: html,
          content_html_version: COMMENT_HTML_VERSION
        }
      })
    } catch (error) {
      // 单条写回失败不影响其他行与本次响应, 下次请求幂等重试
      // eslint-disable-next-line no-console
      console.error('Failed to persist backfilled comment html:', error)
    }
  }
}

// 构建某一页的评论树与总数 (isLike 一律 false, 由调用方按 uid 叠加)
const buildCommentPage = async (
  patchId: number,
  resourceId: number | null,
  limit: number,
  currentPage: number,
  viewer: KunViewer
): Promise<{ comments: PatchComment[]; total: number }> => {
  const visibilityWhere = getCommentRatingVisibilityWhere(viewer)
  const visibilitySql = getCommentVisibilitySql(viewer)

  const commentSelect = {
    id: true,
    content: true,
    content_html: true,
    content_html_version: true,
    is_spoiler: true,
    status: true,
    parent_id: true,
    user_id: true,
    patch_id: true,
    created: true,
    updated: true,
    user: {
      select: {
        id: true,
        name: true,
        avatar: true
      }
    },
    patch: {
      select: {
        unique_id: true
      }
    },
    _count: {
      select: { like_by: true }
    }
  } satisfies Prisma.patch_commentSelect

  const rootWhere = {
    patch_id: patchId,
    parent_id: null,
    resource_id: resourceId,
    ...visibilityWhere
  }

  const [total, rootComments] = await Promise.all([
    prisma.patch_comment.count({ where: rootWhere }),
    prisma.patch_comment.findMany({
      where: rootWhere,
      orderBy: [{ created: 'desc' }, { id: 'desc' }],
      skip: (currentPage - 1) * limit,
      take: limit,
      select: commentSelect
    })
  ])

  const rootIds = rootComments.map((c) => c.id)

  let descendantComments: typeof rootComments = []
  if (rootIds.length > 0) {
    const descendantIdRows = await prisma.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE descendants AS (
        SELECT id, parent_id
        FROM patch_comment
        WHERE parent_id IN (${Prisma.join(rootIds)})
          AND patch_id = ${patchId}
          AND ${visibilitySql}
        UNION ALL
        SELECT pc.id, pc.parent_id
        FROM patch_comment pc
        INNER JOIN descendants d ON pc.parent_id = d.id
        WHERE pc.patch_id = ${patchId} AND ${visibilitySql}
      )
      SELECT id FROM descendants
    `
    const descendantIds = descendantIdRows.map((r) => r.id)

    if (descendantIds.length > 0) {
      descendantComments = await prisma.patch_comment.findMany({
        where: { id: { in: descendantIds }, ...visibilityWhere },
        select: commentSelect
      })
    }
  }

  const commentMap = new Map(
    [...rootComments, ...descendantComments].map((c) => [c.id, c])
  )
  const rootIdSet = new Set(rootIds)

  const findRootId = (commentId: number): number | null => {
    let cursor = commentMap.get(commentId)
    while (cursor && cursor.parent_id !== null) {
      cursor = commentMap.get(cursor.parent_id)
    }
    return cursor ? cursor.id : null
  }

  const replyMap = new Map<number, typeof descendantComments>()
  for (const comment of descendantComments) {
    const rootId = findRootId(comment.id)
    if (rootId !== null && rootIdSet.has(rootId)) {
      const bucket = replyMap.get(rootId)
      if (bucket) {
        bucket.push(comment)
      } else {
        replyMap.set(rootId, [comment])
      }
    }
  }

  const allComments = [...rootComments, ...descendantComments]
  const staleRenders: { id: number; html: string; updated: Date }[] = []
  const htmlEntries = await Promise.all(
    allComments.map(async (c) => {
      if (c.content_html_version === COMMENT_HTML_VERSION && c.content_html) {
        return [c.id, c.content_html] as const
      }
      // 版本不匹配的历史评论: 回落实时渲染, 并记下待写回自愈
      const html = await markdownToHtmlComment(c.content)
      staleRenders.push({ id: c.id, html, updated: c.updated })
      return [c.id, html] as const
    })
  )
  const htmlMap = new Map<number, string>(htmlEntries)

  if (staleRenders.length > 0) {
    void persistStaleCommentHtml(staleRenders).catch(() => undefined)
  }

  const comments: PatchComment[] = rootComments.map((comment) => {
    const replies = replyMap.get(comment.id) || []

    const replyComments: PatchComment[] = replies
      .sort(
        (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime()
      )
      .map((reply) => {
        const directParent = commentMap.get(reply.parent_id!)
        const isReplyToRoot = reply.parent_id === comment.id

        return {
          id: reply.id,
          uniqueId: reply.patch.unique_id,
          content: htmlMap.get(reply.id) ?? '',
          contentPreview: convert(htmlMap.get(reply.id) ?? '').trim(),
          isLike: false,
          isSpoiler: reply.is_spoiler,
          status: reply.status,
          likeCount: reply._count.like_by,
          parentId: comment.id,
          replyToId: reply.parent_id,
          userId: reply.user_id,
          patchId: reply.patch_id,
          created: String(reply.created),
          updated: String(reply.updated),
          reply: [],
          user: {
            id: reply.user.id,
            name: reply.user.name,
            avatar: reply.user.avatar
          },
          quotedContent: null,
          quotedUsername: null,
          replyToUser:
            !isReplyToRoot && directParent
              ? {
                  id: directParent.user.id,
                  name: directParent.user.name,
                  avatar: directParent.user.avatar
                }
              : null
        }
      })

    return {
      id: comment.id,
      uniqueId: comment.patch.unique_id,
      content: htmlMap.get(comment.id) ?? '',
      contentPreview: convert(htmlMap.get(comment.id) ?? '').trim(),
      isLike: false,
      isSpoiler: comment.is_spoiler,
      status: comment.status,
      likeCount: comment._count.like_by,
      parentId: null,
      replyToId: null,
      userId: comment.user_id,
      patchId: comment.patch_id,
      created: String(comment.created),
      updated: String(comment.updated),
      reply: replyComments,
      user: {
        id: comment.user.id,
        name: comment.user.name,
        avatar: comment.user.avatar
      },
      quotedContent: null,
      quotedUsername: null,
      replyToUser: null
    }
  })

  return { comments, total }
}

// 树只有根与其直接回复两层, 收集全部评论 id 用于 isLike 叠加
const collectCommentIds = (comments: PatchComment[]) => {
  const ids: number[] = []
  for (const comment of comments) {
    ids.push(comment.id)
    for (const reply of comment.reply) {
      ids.push(reply.id)
    }
  }
  return ids
}

const applyCommentLikes = async (comments: PatchComment[], uid: number) => {
  if (uid <= 0 || comments.length === 0) {
    return
  }

  const ids = collectCommentIds(comments)
  const likedRows = await prisma.user_patch_comment_like_relation.findMany({
    where: { user_id: uid, comment_id: { in: ids } },
    select: { comment_id: true }
  })
  const likedSet = new Set(likedRows.map((r) => r.comment_id))

  for (const comment of comments) {
    comment.isLike = likedSet.has(comment.id)
    for (const reply of comment.reply) {
      reply.isLike = likedSet.has(reply.id)
    }
  }
}

export const getPatchComment = async (
  input: z.infer<typeof getPatchCommentSchema>,
  viewer: KunViewer
) => {
  const { patchId, limit } = input
  const resourceId = input.resourceId ?? null

  const bypass = await shouldBypassCommentCache(patchId, viewer)
  const effectiveViewer = bypass ? viewer : PUBLIC_VIEWER

  const currentPage = await resolveCurrentPage(input, effectiveViewer)

  const buildPage = () =>
    buildCommentPage(patchId, resourceId, limit, currentPage, effectiveViewer)

  const { comments, total } = bypass
    ? await buildPage()
    : await withPatchCommentPageCache(
        patchId,
        resourceId,
        currentPage,
        limit,
        buildPage
      )

  await applyCommentLikes(comments, viewer.uid)

  return { comments, total, currentPage }
}
