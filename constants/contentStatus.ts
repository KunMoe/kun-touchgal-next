// 评论、评价、资源三张内容表 status 列的取值。零 import, 前后端同构。
// 三张表的「公开」都是 0: 计数触发器、评分统计与 recalcPatchType 都以 status = 0 为公开集

export const COMMENT_STATUS = { public: 0, pending: 1, hidden: 2 } as const

// 取值与评论相同, 单独导出以便日后分叉
export const RATING_STATUS = { public: 0, pending: 1, hidden: 2 } as const

// awaitingApproval 是首个资源的人工初审, pending 是送审后等待裁决
export const RESOURCE_STATUS = {
  public: 0,
  hidden: 1,
  awaitingApproval: 2,
  pending: 3
} as const

export type CommentStatus = (typeof COMMENT_STATUS)[keyof typeof COMMENT_STATUS]
export type RatingStatus = (typeof RATING_STATUS)[keyof typeof RATING_STATUS]
export type ResourceStatus =
  (typeof RESOURCE_STATUS)[keyof typeof RESOURCE_STATUS]

export type ContentKind = 'comment' | 'rating' | 'resource'

// 一条内容所处的阶段。各表的编码不一样 (评论 / 评价的 1 是待审, 资源的 1 是隐藏), 判断只看
// 阶段: awaitingApproval 只有资源有
export type ContentPhase = 'public' | 'pending' | 'awaitingApproval' | 'hidden'

// satisfies 在编译期钉住「三张表的公开都是 0」: 计数触发器、评分统计与 recalcPatchType 都依赖它
export const CONTENT_STATUS = {
  comment: COMMENT_STATUS,
  rating: RATING_STATUS,
  resource: RESOURCE_STATUS
} as const satisfies Record<
  ContentKind,
  { public: 0 } & Partial<Record<ContentPhase, number>>
>

export type ContentStatusOf<K extends ContentKind> =
  (typeof CONTENT_STATUS)[K][keyof (typeof CONTENT_STATUS)[K]] & number

// 这张表里有的那些阶段的编码, 按编码升序; 表里没有的阶段 (评论没有 awaitingApproval) 跳过
export const statusesOf = <K extends ContentKind>(
  kind: K,
  phases: readonly ContentPhase[]
) =>
  (Object.entries(CONTENT_STATUS[kind]) as [ContentPhase, number][])
    .filter(([phase]) => phases.includes(phase))
    .map(([, status]) => status)
    .sort((a, b) => a - b) as ContentStatusOf<K>[]

// 认不出的编码按隐藏处理 (fail-closed): 隐藏对前台所有人都不可见, 也不能被前台操作
export const contentPhase = (
  kind: ContentKind,
  status: number
): ContentPhase => {
  for (const [phase, code] of Object.entries(CONTENT_STATUS[kind])) {
    if (code === status) {
      return phase as ContentPhase
    }
  }
  return 'hidden'
}

// 待审 (送审后等裁决) 与待初审 (首个资源等管理员审批) 都是「还没公开、只有作者与管理员看得到」
export const isPendingPhase = (phase: ContentPhase) =>
  phase === 'pending' || phase === 'awaitingApproval'

export const isPendingStatus = (kind: ContentKind, status: number) =>
  isPendingPhase(contentPhase(kind, status))

export const CONTENT_PHASE_LABEL: Record<ContentPhase, string> = {
  public: '正常',
  pending: '待审核',
  awaitingApproval: '待初次审核',
  hidden: '隐藏'
}

export const contentStatusLabel = (kind: ContentKind, status: number) =>
  CONTENT_PHASE_LABEL[contentPhase(kind, status)]
