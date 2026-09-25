import { SUPPORTED_RESOURCE_SECTION } from '~/constants/resource'
import { parseDeepLinkId } from '~/utils/patch/parseDeepLinkId'

export interface PatchTabTargets {
  commentId: number | null
  ratingId: number | null
  resourceId: number | null
  resourceSection: string | null
}

interface SearchParamsGetter {
  get: (key: string) => string | null
}

export const readPatchTabTargets = (
  searchParams: SearchParamsGetter
): PatchTabTargets => {
  const section = searchParams.get('resourceSection')

  return {
    commentId: parseDeepLinkId(searchParams.get('commentId')),
    ratingId: parseDeepLinkId(searchParams.get('ratingId')),
    resourceId: parseDeepLinkId(searchParams.get('resourceId')),
    resourceSection:
      section && SUPPORTED_RESOURCE_SECTION.includes(section) ? section : null
  }
}

// 切 tab 会把其它 tab 的深链参数从 URL 剥掉. 保活的隐藏面板若随之拿到 null, 评论会
// 在隐藏时重拉并重挂载 (display:none 下测高为 0, 长评论丢掉展开按钮), 评价会被整体
// 重置. 故每组目标只会被新的深链替换, 不因剥参数而清空; 资源的分区与 id 成组替换
export const mergePatchTabTargets = (
  current: PatchTabTargets,
  searchParams: SearchParamsGetter
): PatchTabTargets => {
  const next = readPatchTabTargets(searchParams)
  const hasResourceTarget =
    next.resourceId !== null || next.resourceSection !== null
  const merged: PatchTabTargets = {
    commentId: next.commentId ?? current.commentId,
    ratingId: next.ratingId ?? current.ratingId,
    resourceId: hasResourceTarget ? next.resourceId : current.resourceId,
    resourceSection: hasResourceTarget
      ? next.resourceSection
      : current.resourceSection
  }

  const unchanged =
    merged.commentId === current.commentId &&
    merged.ratingId === current.ratingId &&
    merged.resourceId === current.resourceId &&
    merged.resourceSection === current.resourceSection
  return unchanged ? current : merged
}
