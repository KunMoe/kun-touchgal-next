import { POINT_RULES } from '~/constants/points'
import { randomNormalInt } from '~/utils/random'
import type { KunTx } from '~/prisma/index'

// user.moemoepoint 的唯一写者 (lint kun/inv-points-01 执法), 数值取自 constants/points.ts。
// 每个函数固定一种 Prisma 调用形状:
// - 有守卫的扣费与领取是条件 updateMany, 守卫与写入在同一条 UPDATE 的平铺 WHERE 里 (CAS):
//   READ COMMITTED 下后到者在行锁上等待, 拿锁后重新求值 WHERE。这靠编译出来的 SQL 形状,
//   若改发 WHERE id IN (SELECT ...) 子查询, 重新求值不覆盖子查询 (另一个 RTE, 仍用语句起始
//   快照), 守卫会静默失效。所以守卫只放标量列 (关系过滤同样编译成子查询)。形状由各调用点的
//   __tests__/*.sql.test.ts 守护, 重新求值由签到的 route.db.test.ts 在真库上守护
// - 与扣费、领取绑在一起的列 (改名的 name、签到的 daily_check_in、发布 Galgame 的
//   daily_image_count) 写在同一条语句里: 拆开后改名撞唯一索引会白扣, 签到会重复领
// - 余额不设下限, 库里也不加 CHECK: 取消点赞、收回奖励与后台调分都是无守卫的负向写入
// 提交之后的会话失效留在调用点
type PointDb = KunTx

export type PointCreditReason = 'resource_publish' | 'like_received'

const CREDIT = {
  resource_publish: POINT_RULES.resourcePublish.credit,
  like_received: POINT_RULES.likeReceived.credit
} as const satisfies Record<PointCreditReason, number>

// 无守卫的加分: 发布资源、被点赞
export const creditPoints = async (
  db: PointDb,
  uid: number,
  reason: PointCreditReason
) => {
  await db.user.update({
    where: { id: uid },
    data: { moemoepoint: { increment: CREDIT[reason] } }
  })
}

// 取消点赞: 收回被赞奖励, 余额可以因此为负
export const reverseCredit = async (
  db: PointDb,
  uid: number,
  reason: 'like_received'
) => {
  await db.user.update({
    where: { id: uid },
    data: { moemoepoint: { increment: -CREDIT[reason] } }
  })
}

// 发布 Galgame: 奖励与封面占用的当日图片计数在同一条 UPDATE 里
export const creditGalgamePublish = async (db: PointDb, uid: number) => {
  await db.user.update({
    where: { id: uid },
    data: {
      daily_image_count: { increment: 1 },
      moemoepoint: { increment: POINT_RULES.galgamePublish.credit }
    }
  })
}

// 每日签到: 签到标记只收敛在 daily_check_in 一列, 条件更新即 CAS, 无需通告锁或重试。
// 用户不存在时 count 为 0, 与今天已签到同样不加分
export const claimCheckIn = async (db: PointDb, uid: number) => {
  const amount = randomNormalInt(
    POINT_RULES.checkIn.min,
    POINT_RULES.checkIn.max
  )
  const { count } = await db.user.updateMany({
    where: { id: uid, daily_check_in: 0 },
    data: {
      moemoepoint: { increment: amount },
      daily_check_in: { set: 1 }
    }
  })
  return { claimed: count > 0, amount }
}

// 改名扣费: 余额守卫与 name 守卫都在 WHERE 里, 改名与扣费是同一条语句。name 守卫是资金侧
// 兜底: 鉴权缓存陈旧时同一个新名字的重试 (或并发双提交) 不会被扣第二次, 代价是此时 count
// 为 0、被当成余额不足, 而用户确实已被扣过一次。返回 false 即没有扣费也没有改名
export const spendOnRename = async (
  db: PointDb,
  uid: number,
  name: string
): Promise<boolean> => {
  const { count } = await db.user.updateMany({
    where: {
      id: uid,
      moemoepoint: { gte: POINT_RULES.rename.minBalance },
      name: { not: name }
    },
    data: { name, moemoepoint: { increment: -POINT_RULES.rename.cost } }
  })
  return count > 0
}

// 发起私聊的扣费。守卫用门槛而不是价格: 保留「要有 20 才能开一个, 付 10」的语义
export const spendOnConversation = async (
  db: PointDb,
  uid: number
): Promise<boolean> => {
  const { count } = await db.user.updateMany({
    where: {
      id: uid,
      moemoepoint: { gte: POINT_RULES.conversation.minBalance }
    },
    data: { moemoepoint: { decrement: POINT_RULES.conversation.cost } }
  })
  return count > 0
}

// 后台调分按差值写入: 打开表单之后发生的签到、被赞、消费都保留。不设下限 (所有者
// 2026-11-25 裁定)。返回写后的余额; 用户不存在时 update 抛 P2025
export const adjustPoints = async (
  db: PointDb,
  uid: number,
  delta: number
): Promise<number> => {
  const { moemoepoint } = await db.user.update({
    where: { id: uid },
    data: { moemoepoint: { increment: delta } },
    select: { moemoepoint: true }
  })
  return moemoepoint
}

export type PointRevokeReason = 'resource_publish'

// 收回奖励: ownerIds 每个元素收回一份 (同一作者删了几个资源就出现几次), 按作者升序写。
// user 行是最后一层锁: 调用方要在内容行与 patch 行都锁好、删除之后再调, 锁序是
// 内容行 → patch 行 → user 行, 与点赞 (资源行经外键 → 作者 user 行)、发布资源 (patch 行经
// 计数触发器 → user 行) 同向。若先锁 user 行, 两者在真库上都会与删除互等 (docs/tasks/t30)。
// 审核裁决对资源只取 user 行的 FOR KEY SHARE, 与这里的写不冲突。返回被收回的作者 (升序去重)
export const revokeCredits = async (
  tx: PointDb,
  reason: PointRevokeReason,
  ownerIds: readonly number[]
): Promise<number[]> => {
  const units = new Map<number, number>()
  for (const uid of ownerIds) {
    units.set(uid, (units.get(uid) ?? 0) + 1)
  }
  const uids = [...units.keys()].sort((a, b) => a - b)
  for (const uid of uids) {
    await tx.user.update({
      where: { id: uid },
      data: {
        moemoepoint: { increment: -CREDIT[reason] * (units.get(uid) ?? 0) }
      }
    })
  }
  return uids
}
