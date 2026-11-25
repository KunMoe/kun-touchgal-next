// 三张内容表的合法状态迁移: 每条迁移从哪些状态出发、到哪个状态。纯数据, 按实体分表, 原样作为
// server/content/** 里 transitionComments / transitionRatings / transitionResources 的
// from / to 参数。命令在行锁下只迁移 from 之内的行, 改一种迁移的口径只改这里的一行
import {
  COMMENT_STATUS,
  RATING_STATUS,
  RESOURCE_STATUS
} from '~/constants/contentStatus'
import type {
  CommentStatus,
  RatingStatus,
  ResourceStatus
} from '~/constants/contentStatus'

interface ContentTransition<S extends number> {
  from: readonly S[]
  to: S
}

export const COMMENT_TRANSITIONS = {
  // 审核裁决只对仍在待审的行生效
  verdictApprove: { from: [COMMENT_STATUS.pending], to: COMMENT_STATUS.public },
  verdictReject: { from: [COMMENT_STATUS.pending], to: COMMENT_STATUS.hidden },
  // 管理员屏蔽 / 恢复。待审期间也能屏蔽 (资源不行, 见下), 恢复时也会把待审的直接放出
  hide: {
    from: [COMMENT_STATUS.public, COMMENT_STATUS.pending],
    to: COMMENT_STATUS.hidden
  },
  unhide: {
    from: [COMMENT_STATUS.pending, COMMENT_STATUS.hidden],
    to: COMMENT_STATUS.public
  },
  // 申诉通过只恢复仍是隐藏的内容; 驳回时删除守卫用同一个 from
  appealApprove: { from: [COMMENT_STATUS.hidden], to: COMMENT_STATUS.public }
} as const satisfies Record<string, ContentTransition<CommentStatus>>

export const RATING_TRANSITIONS = {
  verdictApprove: { from: [RATING_STATUS.pending], to: RATING_STATUS.public },
  verdictReject: { from: [RATING_STATUS.pending], to: RATING_STATUS.hidden },
  hide: {
    from: [RATING_STATUS.public, RATING_STATUS.pending],
    to: RATING_STATUS.hidden
  },
  unhide: {
    from: [RATING_STATUS.pending, RATING_STATUS.hidden],
    to: RATING_STATUS.public
  },
  appealApprove: { from: [RATING_STATUS.hidden], to: RATING_STATUS.public }
} as const satisfies Record<string, ContentTransition<RatingStatus>>

export const RESOURCE_TRANSITIONS = {
  verdictApprove: {
    from: [RESOURCE_STATUS.pending],
    to: RESOURCE_STATUS.public
  },
  verdictReject: {
    from: [RESOURCE_STATUS.pending],
    to: RESOURCE_STATUS.hidden
  },
  // 首个资源的人工初审通过
  approveFirst: {
    from: [RESOURCE_STATUS.awaitingApproval],
    to: RESOURCE_STATUS.public
  },
  // 管理员隐藏 / 恢复只在公开与隐藏之间: 待初审与待审是系统态, 不被这两条迁移命中
  hide: { from: [RESOURCE_STATUS.public], to: RESOURCE_STATUS.hidden },
  unhide: { from: [RESOURCE_STATUS.hidden], to: RESOURCE_STATUS.public },
  appealApprove: { from: [RESOURCE_STATUS.hidden], to: RESOURCE_STATUS.public }
} as const satisfies Record<string, ContentTransition<ResourceStatus>>
