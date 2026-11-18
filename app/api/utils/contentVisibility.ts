import { Prisma } from '~/prisma/generated/prisma/client'
import { hasPendingResource } from '~/app/api/utils/pendingResourceCache'
import { can } from '~/constants/permission'

export interface KunViewer {
  uid: number
  role: number
}

// 待审核内容仅作者与有 content.viewPending 能力的角色可见
export const isContentVisibleToViewer = (
  viewer: KunViewer | null,
  ownerId: number
) => !!viewer && (can(viewer, 'content.viewPending') || viewer.uid === ownerId)

// patch_comment / patch_rating 的可见性 WHERE 片段
// status: 0 正常, 1 待审核 (仅作者与有 content.viewPending 能力的角色可见),
// 2 隐藏 (前台对所有人不可见, 含管理员, 仅 /admin 可管理)
export const getCommentRatingVisibilityWhere = (viewer: KunViewer | null) => {
  if (can(viewer, 'content.viewPending')) {
    return { status: { in: [0, 1] } }
  }
  if (viewer && viewer.uid > 0) {
    return { OR: [{ status: 0 }, { status: 1, user_id: viewer.uid }] }
  }
  return { status: 0 }
}

// patch_resource 的可见性 WHERE 片段
// status: 0 正常, 1 隐藏 (仅 /admin), 2 待初次审核, 3 待审核
// (2/3 待审核仅作者与有 content.viewPending 能力的角色可见; 1 隐藏对所有前台 viewer 不可见)
export const getResourceVisibilityWhere = (viewer: KunViewer | null) => {
  if (can(viewer, 'content.viewPending')) {
    return { status: { in: [0, 2, 3] } }
  }
  if (viewer && viewer.uid > 0) {
    return {
      OR: [{ status: 0 }, { status: { in: [2, 3] }, user_id: viewer.uid }]
    }
  }
  return { status: 0 }
}

// 评论抓取递归 CTE 中的原生 SQL 片段 (语义同 getCommentRatingVisibilityWhere)
export const getCommentVisibilitySql = (viewer: KunViewer | null) =>
  can(viewer, 'content.viewPending')
    ? Prisma.sql`status IN (0, 1)`
    : Prisma.sql`(status = 0 OR (status = 1 AND user_id = ${viewer?.uid ?? 0}))`

// 共享(跨 viewer)缓存必须对响应不同于公开版本的 viewer 跳过:
// 管理员 (可见他人待审核内容), 以及有待审核资源(status 2/3)的作者
// (需持续看到自己待审核的资源, 带下载链接)
export const shouldBypassSharedCache = async (viewer: KunViewer | null) => {
  if (!viewer) {
    return false
  }
  if (can(viewer, 'content.viewPending')) {
    return true
  }

  return hasPendingResource(viewer.uid)
}
