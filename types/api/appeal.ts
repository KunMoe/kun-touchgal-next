export interface AppealPayload {
  text?: string
  name?: string
  note?: string
}

// appealable - 可申诉; unavailable - 内容已删除 / 状态已变更 / 被更新的拒绝记录取代
export type UserAppealState =
  'appealable' | 'unavailable' | 'pending' | 'approved' | 'rejected'

export interface UserAppealItem {
  taskId: number
  contentType: string
  contentId: number
  // 类别码原文, 由前端经 MODERATION_REJECT_CODE_MAP 映射为类别名展示;
  // 具体命中点 (reject_reason) 不下发给用户
  rejectCode: string
  rejectedAt: Date | string | null
  patchName: string | null
  original: AppealPayload | null
  state: UserAppealState
  appeal: {
    id: number
    status: string
    payload: AppealPayload
    updated: Date | string
  } | null
}

export interface AdminAppealItem {
  id: number
  contentType: string
  contentId: number
  status: string
  payload: AppealPayload
  original: AppealPayload | null
  rejectReason: string
  user: KunUser
  // 内容所属的游戏; 内容已删除时为 null
  patch: {
    uniqueId: string
    name: string
  } | null
  created: Date | string
  updated: Date | string
}
