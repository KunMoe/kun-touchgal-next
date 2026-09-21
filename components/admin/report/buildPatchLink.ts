import { buildCommentLink } from '~/utils/patch/buildCommentLink'
import type { AdminReport } from '~/types/api/admin'

export const buildPatchLink = (report: AdminReport) => {
  const uniqueId = report.patch.uniqueId
  if (!uniqueId) {
    return ''
  }
  // 评论深链与站内信同源 (资源评论指向资源详情页, 游戏评论指向 comments 标签页)
  if (report.targetType === 'comment' && report.comment) {
    return buildCommentLink(
      uniqueId,
      report.comment.id,
      report.comment.resourceId
    )
  }
  if (report.targetType === 'rating' && report.rating) {
    return `/${uniqueId}?tab=rating&ratingId=${report.rating.id}`
  }
  // 被举报内容已删除: 回落游戏详情页
  return `/${uniqueId}`
}
