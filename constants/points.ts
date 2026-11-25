// 萌萌点的规则数值只在这里有一份: 服务端的发放、扣费与门槛, 客户端的预检与提示都从这里取。
// 写 user.moemoepoint 的只有 server/points/account.ts。公示 (posts/notice/moemoepoint.mdx、
// role.mdx、common.mdx) 是手写的, 改这里的数值要同步改那三篇
export const POINT_RULES = {
  // 资源被删除 (作者删、后台删、初审拒绝、申诉驳回) 时收回; 删游戏、隐藏不收回
  resourcePublish: { credit: 3 },
  galgamePublish: { credit: 3 },
  // 评论、评价、资源被点赞; 取消点赞时收回 (余额可以因此为负)
  likeReceived: { credit: 1 },
  // 每日签到在 [min, max] 里按正态分布取整
  checkIn: { min: 2, max: 7 },
  // 门槛一律是「不少于 minBalance」, 与价格分开写: 私聊要有 20 才能开, 只扣 10
  rename: { cost: 30, minBalance: 30 },
  conversation: { cost: 10, minBalance: 20 },
  publishResource: { minBalance: 20 }
} as const

export type PointGate = 'publishResource' | 'conversation' | 'rename'

export const meetsPointGate = (
  gate: PointGate,
  account: { moemoepoint: number }
): boolean => account.moemoepoint >= POINT_RULES[gate].minBalance

// 门槛没过时的提示。角色豁免不在这里: 发布资源的豁免见 constants/permission.ts 的
// canPublishResource, 私聊的豁免与免费由入口按 message.skipPointsGate 判
export const POINT_GATE_MESSAGE: Record<PointGate, string> = {
  publishResource: `仅限萌萌点不少于 ${POINT_RULES.publishResource.minBalance} 的用户才可以发布资源`,
  conversation: `萌萌点不足，发起私聊需要至少 ${POINT_RULES.conversation.minBalance} 萌萌点`,
  rename: `更改用户名最少需要 ${POINT_RULES.rename.minBalance} 萌萌点, 您的萌萌点不足`
}
