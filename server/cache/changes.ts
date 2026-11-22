import type {
  CommentStatus,
  RatingStatus,
  ResourceStatus
} from '~/constants/contentStatus'

// 写路径交给缓存规划器 (plan.ts) 的领域变更。只写处理器本来就握有的行级事实 (哪一行、改之前
// 与改之后的状态), 不写「哪个缓存要失效」「某个计数变没变」这类结论: 结论只在 plan.ts 推一次。
//
// before / after 为 null 表示行此前不存在 / 已删除, 且只能取自行锁下读到的值或删除语句
// RETURNING 的值。取自事务外快照的话, 并发的状态迁移会让闸门算错 (d33aab60、64fedb7f 修的
// 就是这一类)。id、patchId、uniqueId、ownerId 是建行后不再改的标识, 取自快照也可以

export interface KunResourceState {
  status: ResourceStatus
  section: string
}

export type KunChange =
  // 评论 / 评价 / 资源三张内容表的一行, 只描述锁下真正迁移、新建或删除的行
  | {
      kind: 'comment'
      id: number
      patchId: number
      resourceId: number | null
      before: CommentStatus | null
      after: CommentStatus | null
    }
  | {
      kind: 'rating'
      patchId: number
      before: RatingStatus | null
      after: RatingStatus | null
      // 公开评价的评分或推荐度被改动 (统计随之变化)
      scoreChanged: boolean
    }
  | {
      kind: 'resource'
      id: number
      patchId: number
      ownerId: number
      before: KunResourceState | null
      after: KunResourceState | null
    }
  // 公开资源的点赞数或下载数变了 (点赞与取消点赞、计一次下载、点赞者被删号的级联)
  | { kind: 'resourceReaction'; patchId: number; reaction: 'like' | 'download' }
  // patch 行上被详情缓存内嵌的列被改写 (资源聚合 type / language / platform、resource_update_time)
  | { kind: 'patch'; patchId: number; uniqueId: string }
  // patch 行被删除。随级联消失的资源另由 resource 变更 (after 为 null) 描述
  | { kind: 'patchDeleted'; patchId: number; uniqueId: string }
