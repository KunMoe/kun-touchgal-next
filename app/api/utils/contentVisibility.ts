import { hasPendingResource } from '~/app/api/utils/pendingResourceCache'
import { can } from '~/constants/permission'
import { RESOURCE_STATUS } from '~/constants/contentStatus'
import { visibleWhere } from '~/server/content/visibility'
import type { ListView } from '~/server/viewer/patchVisibility'
import type { Prisma } from '~/prisma/generated/prisma/client'

export interface KunViewer {
  uid: number
  role: number
}

// 可见性的口径在 utils/content/policy.ts, 谓词在 server/content/visibility.ts。这个名字
// 留给既有调用方
export const getResourceVisibilityWhere = (viewer: KunViewer | null) =>
  visibleWhere('resource', viewer)

// 列表里的资源按视角取 status 条件: 只有 personal 视角看得到待审核资源。shared 与 filtered
// 一律按公开基线, 共享缓存里才不会混进因人而异的内容
export const getListResourceStatusWhere = (view: ListView) =>
  view.kind === 'personal'
    ? getResourceVisibilityWhere(view.viewer)
    : { status: RESOURCE_STATUS.public }

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

// 私密收藏夹: 从收藏关系派生、对他人可见的任何信息 (收藏夹列表、内容、计数、通知),
// 以观看方或接收方能否看到源收藏夹为准。游客的 viewerUid 传 0
export const getFavoriteFolderVisibilityWhere = (
  ownerUid: number,
  viewerUid: number
): Prisma.user_patch_favorite_folderWhereInput =>
  ownerUid === viewerUid
    ? { user_id: ownerUid }
    : { user_id: ownerUid, is_public: true }

export const isFavoriteFolderVisibleTo = (
  folder: { user_id: number; is_public: boolean },
  viewerUid: number
) => folder.is_public || folder.user_id === viewerUid
