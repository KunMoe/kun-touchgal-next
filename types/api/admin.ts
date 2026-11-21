import type { PatchResource } from '~/types/api/patch'
import type { PatchComment } from '~/types/api/comment'
import type { Message } from '~/types/api/message'
import type { PurgedUserReference } from '~/server/account/userReferences'
import type { ModerationHealth } from '~/server/moderation/health'

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
  // 写日志的管理员账号已删除时为 null
  user: KunUser | null
  content: string
  created: Date | string
}

// 一次群发邮件任务的进度 (server/mail/campaign.ts)。total 是创建时估计的收件人数,
// 发送期间有人退订, 最终的 sent + failed 可以比它小
export interface AdminMailCampaign {
  id: number
  templateId: string
  title: string
  // sending | paused | done | cancelled
  status: string
  total: number
  sent: number
  failed: number
  // 自动暂停的原因, 没有暂停过或已继续发送时为空串
  lastError: string
  // 发起的管理员账号已删除时为 null
  creator: KunUser | null
  created: Date | string
  finished: Date | string | null
}

// 删号一次请求的结果 (server/account/deleteAccount.ts)。内容多的账号要分几次请求才能清完:
// done 为 false 时账号已封禁、内容删了一部分, remaining 是各类还剩的行数, 再请求一次即可续上
export type AdminUserDeletionRemaining = Partial<
  Record<PurgedUserReference, number>
>

export type AdminUserDeletionResult =
  { done: true } | { done: false; remaining: AdminUserDeletionRemaining }

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
  // 依赖类失败 (供应商不可用、限流、配置错误) 的推迟次数, 与 retry 分开记账
  deferCount: number
  // 最近一次失败的类别 (MODERATION_FAILURE_KIND); 空串 = 没有失败过或裁决已落定
  failureKind: string
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
  // 添加规则的管理员账号已删除时为 null
  user: KunUser | null
  created: Date | string
}

export interface AdminModerationStats {
  todayTotal: number
  statusCounts: Record<string, number>
  tokensIn: number
  tokensOut: number
  // 审核 worker 上报的车道状态; null = 超过两分钟没有上报 (cron 进程可能没在运行)
  worker: ModerationHealth | null
  // 最早一条仍在待审核的任务的创建时间; 队列为空时为 null
  oldestPendingAt: Date | string | null
  // 转人工的任务按失败类别 (MODERATION_FAILURE_KIND) 计数
  manualKindCounts: Record<string, number>
  // 没有失败类别的转人工任务: AI 拿不准的 (有裁决), 与引入失败类别之前转人工的
  manualUnsureCount: number
  manualUnclassifiedCount: number
}
