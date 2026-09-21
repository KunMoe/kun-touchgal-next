import type { PatchResource } from '~/types/api/patch'
import type { PatchComment } from '~/types/api/comment'
import type { Message } from '~/types/api/message'

export type AdminStatsName =
  'user' | 'active' | 'patch' | 'patch_resource' | 'patch_comment'

export interface SumData {
  userCount: number
  galgameCount: number
  galgameResourceCount: number
  galgamePatchResourceCount: number
  galgameCommentCount: number
}

export interface OverviewData {
  newUser: number
  newActiveUser: number
  newGalgame: number
  newGalgameResource: number
  newComment: number
}

export interface AdminUser {
  id: number
  name: string
  email: string
  enable2FA: boolean
  bio: string
  avatar: string
  role: number
  status: number
  dailyImageCount: number
  moemoepoint: number
  created: Date | string
  _count: {
    patch: number
    patch_resource: number
  }
}

export interface AdminCreator {
  id: number
  content: string
  status: number
  sender: KunUser | null
  patchResourceCount: number
  created: Date | string
}

export interface AdminGalgame {
  id: number
  uniqueId: string
  name: string
  banner: string
  user: KunUser
  created: Date | string
}

export interface AdminResource extends PatchResource {
  patchName: string
}

export type AdminComment = PatchComment & {
  // 0 - 正常, 1 - 待审核, 2 - 隐藏 (/admin only)
  status: number
}

export interface AdminRating {
  id: number
  uniqueId: string
  user: KunUser
  recommend: string
  overall: number
  playStatus: string
  shortSummary: string
  spoilerLevel: string
  patchName: string
  patchId: number
  like: number
  // 0 - 正常, 1 - 待审核, 2 - 隐藏 (/admin only)
  status: number
  created: Date | string
}

export type AdminFeedback = Message

export type AdminReportTargetType = 'comment' | 'rating'

export interface AdminReportPatchSummary {
  id: number
  uniqueId: string
  name: string
}

export interface AdminReportCommentSummary {
  id: number
  contentPreview: string
  // 资源评论的资源 id (深链到资源详情页); 游戏评论为 null
  resourceId: number | null
}

export interface AdminReportRatingSummary {
  id: number
  shortSummary: string
  overall: number
  recommend: string
  playStatus: string
}

export interface AdminReport {
  id: number
  targetType: AdminReportTargetType
  status: number
  reason: string
  handlerReply: string
  handledAt: Date | string | null
  created: Date | string
  sender: KunUser
  reportedUser: KunUser | null
  handler: KunUser | null
  patch: AdminReportPatchSummary
  comment: AdminReportCommentSummary | null
  rating: AdminReportRatingSummary | null
}

export interface AdminLog {
  id: number
  type: string
  user: KunUser
  content: string
  created: Date | string
}

export interface AdminRedirectConfig {
  enableRedirect: boolean
  excludedDomains: string[]
  delaySeconds: number
}

export interface AdminModerationTask {
  id: number
  contentType: string
  contentId: number | null
  status: string
  rejectCode: string
  rejectReason: string
  payload: {
    text?: string
    name?: string
    bio?: string
    pendingLink?: string
    archiveLink?: string
  }
  verdict: unknown
  model: string
  tokensIn: number
  tokensOut: number
  retry: number
  dryRun: boolean
  user: KunUser
  // 资源评论任务的资源 id (深链到资源详情页); 其余任务为 null
  commentResourceId?: number | null
  // 评论 / 评价 / 资源所属的游戏; 头像 / 签名任务或内容已删除时为 null
  patch: {
    uniqueId: string
    name: string
  } | null
  created: Date | string
  reviewed: Date | string | null
}

export interface AdminModerationBlacklistItem {
  id: number
  pattern: string
  // 生效的文本类型; 空数组 = 全部生效
  contentTypes: string[]
  user: KunUser
  created: Date | string
}

export interface AdminModerationStats {
  todayTotal: number
  statusCounts: Record<string, number>
  tokensIn: number
  tokensOut: number
}
