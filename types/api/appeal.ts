import type {
  ResourceLinkSubjectFields,
  ResourceSubjectFields
} from '~/server/moderation/subject'

// 资源申诉里的一条链接: 可改的就是这条链接上送审的字段 (随 RESOURCE_LINK_FIELD_POLICY
// 增减), 送审字段新增而申诉不提供它时编译失败。id 对应资源已有的链接行; storage 只读,
// 一律由服务端按库中的行填写
export type AppealLink = ResourceLinkSubjectFields & { id: number }

// 资源本体上送审的字段 (标题、介绍、模型型号), 随 RESOURCE_FIELD_POLICY 增减
export type AppealResourceField = Exclude<keyof ResourceSubjectFields, 'links'>

// comment / rating 只有 text; resource 是资源本体上的各字段加 links。
// modelName 只在 AI 翻译补丁的申诉里出现 (其余类型没有这个字段); 它与 links 在较早
// 提交的申诉里都没有, 表示保持不变
export interface AppealPayload extends Partial<
  Record<AppealResourceField, string>
> {
  text?: string
  // 资源的各条链接, 按展示顺序
  links?: AppealLink[]
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
