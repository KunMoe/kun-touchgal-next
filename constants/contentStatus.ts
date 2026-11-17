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
