// 指向 user 的每一条外键在账号删除时的语义。纯常量, 不 import prisma: 守护测试
// (prisma/__tests__/user-fk-actions.test.ts) 读 schema 文本, 断言外键集合与这张表的键
// 双向相等、各自的 onDelete 与归类相符。新增指向 user 的外键, 先在这里归类。
//
// 归类规则:
//   cascade   子行删除的效果只留在库内 (行本身, 或触发器维护的计数), 随 user 行由库级联删除。
//             被缓存内嵌的 cascade 行在 CASCADE_PROJECTIONS 登记收集函数, 收尾时失效
//   set-null  表达「谁建的 / 谁操作的」: 账号消失, 记录本身留下, 只断开归属 (外键 SetNull,
//             列可空, 读点显示「已注销用户」)
//   purge     有库外效果 (S3、搜索索引、审核队列、站内信死链、派生计数): 删除前必须经领域
//             服务清除 (server/account/purgers.ts), 收尾时在 user 行锁下复核为 0 才删 user 行
//
// patch.user_id 是建档人, 按所有者 2026-11-19 的裁定维持 purge: 删号连同其建档的游戏
// (以及其他人挂在这些游戏下的内容) 一起删除
export type UserReferenceAction = 'cascade' | 'set-null' | 'purge'

export const USER_REFERENCES = {
  'patch.user_id': 'purge',
  'patch_resource.user_id': 'purge',
  'patch_comment.user_id': 'purge',
  'patch_rating.user_id': 'purge',

  'patch_tag.user_id': 'set-null',
  'patch_company.user_id': 'set-null',
  'moderation_blacklist.user_id': 'set-null',
  'admin_log.user_id': 'set-null',
  'patch_report.handler_id': 'set-null',

  'user_follow_relation.follower_id': 'cascade',
  'user_follow_relation.following_id': 'cascade',
  'user_message.sender_id': 'cascade',
  'user_message.recipient_id': 'cascade',
  'user_conversation.user_a_id': 'cascade',
  'user_conversation.user_b_id': 'cascade',
  'user_private_message.sender_id': 'cascade',
  'user_patch_favorite_folder.user_id': 'cascade',
  'user_patch_comment_like_relation.user_id': 'cascade',
  'user_patch_resource_like_relation.user_id': 'cascade',
  'patch_rating_like.user_id': 'cascade',
  'moderation_task.user_id': 'cascade',
  'moderation_appeal.user_id': 'cascade',
  'patch_report.sender_id': 'cascade',
  'patch_report.reported_user_id': 'cascade',
  'user_email_change.user_id': 'cascade'
} as const satisfies Record<string, UserReferenceAction>

export type UserReference = keyof typeof USER_REFERENCES

export type PurgedUserReference = {
  [K in UserReference]: (typeof USER_REFERENCES)[K] extends 'purge' ? K : never
}[UserReference]
