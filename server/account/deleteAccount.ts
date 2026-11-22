import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import {
  enqueueS3Deletion,
  kickS3DeletionDrain
} from '~/server/storage/s3Outbox'
import { getUserAvatarKeys } from '~/app/api/user/setting/_upload'
import { invalidatePatchContentCacheByPatchId } from '~/app/api/patch/cache'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { recordKunChanges } from '~/server/cache/publish'
import { COMMENT_STATUS, RESOURCE_STATUS } from '~/constants/contentStatus'
import { ACCOUNT_PURGERS, ACCOUNT_PURGE_ORDER } from './purgers'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { KunActor } from '~/constants/role'
import type {
  AdminUserDeletionRemaining,
  AdminUserDeletionResult
} from '~/types/api/admin'
import type { PurgeCountDb } from './purgers'
import type { CascadedUserReference } from './userReferences'
import type { KunChange } from '~/server/cache/changes'

// 账号删除 (全仓唯一的 user.delete)。三步, 各自是独立的事务, 中途失败或超出预算都可以重跑续上:
//   1. 封禁先行: status=2 与「开始删除」日志在同一事务里, 提交之后删光会话。此后该账号的新请求都被
//      现有的 status 闸门拒绝 (会话解析、登录、2FA 第二步、OIDC), 不另设「删除中」状态; 清除期间
//      内容的可见性与删除之前相同
//   2. 按 ACCOUNT_PURGE_ORDER 调清除器, 每批调一次现成的删除服务, 直到清完或超出预算
//   3. 收尾: 锁住 user 行, 在锁下复核每一类 purge 都是 0, 才删 user 行; 其余引用由库按
//      userReferences.ts 的归类级联或置空
//
// 收尾的完备性靠锁, 不靠封禁: 封禁只拦得住新请求, 已经通过鉴权的在途请求照样会提交。插入任何引用
// 该用户的行, 外键检查都要对 user 行取 FOR KEY SHARE, 与这里的 FOR UPDATE 冲突 (契约测试
// __tests__/deleteAccount.db.test.ts)。所以锁下计数为 0 就意味着此后不会再出现新的 purge 类行:
// 在途的插入要么已提交 (被计数看到, 回到第 2 步), 要么排在收尾之后、因 user 行已不存在而外键失败
// (新建资源由 patch/resource/create.ts 的 abandonBoundResourceObjects 回收已复制的对象)。
// 这只覆盖引用该用户的行: 别人在他建档的游戏下并发新建的资源不归这里管, 随 deletePatchById 的级联
// 消失, 那是 patch/delete.ts 自己写明的已知残留 (从后台删游戏也一样), 修在那里会自动覆盖删号。
//
// 锁序: 收尾是唯一一处先锁被删用户 user 行的删除步骤, 之后才由级联碰其余子行; 清除器调用的服务
// 都不碰 user 行。走到收尾时该用户已没有评论 / 评价 / 资源 / 游戏, 「先碰内容行、后写作者 user 行」
// 的点赞与申诉处理不会再与它互等 (9aff4253 撤掉「事务开头先锁 user 行」防的就是这一类)。剩下的
// 互等 (例如别人正给他发私信: 先锁会话行、再经外键碰 user 行) 由数据库判死锁回滚一方, 收尾重放

// 一次请求里清除的时间预算, 超出就返回 done:false, 管理员再点一次续上。须低于反代的源站超时
// (nginx 默认 60s)。在批与批之间检查, 删游戏的批内也检查; 一批本身与收尾还可能再花几秒
const ACCOUNT_DELETION_BUDGET_MS = 20_000

// 收尾在锁下发现还有残余 (在途请求刚提交的内容) 时回到第 2 步, 最多来回这么多轮
const ACCOUNT_FINALIZE_ROUNDS = 3

type CascadeProjection = {
  // 收尾事务里、user 行锁下收集受影响的 patch
  collect(tx: Prisma.TransactionClient, uid: number): Promise<number[]>
} &
  // 报告给缓存规划器的变更, 由它决定提交后失效什么
  (
    | { changes(patchIds: number[]): KunChange[] }
    // 规划器还没接上的族 (T15 S3): 提交之后直接失效
    | { invalidate(patchIds: number[]): Promise<unknown> }
  )

const patchIdsOf = (rows: Array<{ patch_id: number }>) =>
  rows.map((row) => row.patch_id)

// cascade 行里被共享缓存内嵌的部分: 库级联删掉这些行, 缓存里的计数不会跟着变。没登记的 cascade
// 行没有被共享缓存内嵌, 或缓存本身足够短 (站内信未读标记 30 秒)
const CASCADE_PROJECTIONS = {
  // 与点赞入口报告的是同一个变更。资源详情缓存只装公开资源
  'user_patch_resource_like_relation.user_id': {
    collect: async (tx, uid) =>
      patchIdsOf(
        await tx.patch_resource.findMany({
          where: {
            like_by: { some: { user_id: uid } },
            status: RESOURCE_STATUS.public
          },
          select: { patch_id: true },
          distinct: ['patch_id']
        })
      ),
    changes: (patchIds) =>
      patchIds.map((patchId) => ({
        kind: 'resourceReaction',
        patchId,
        reaction: 'like'
      }))
  },
  // 评论分页缓存内嵌点赞数, 只装公开评论
  'user_patch_comment_like_relation.user_id': {
    collect: async (tx, uid) =>
      patchIdsOf(
        await tx.patch_comment.findMany({
          where: {
            like_by: { some: { user_id: uid } },
            status: COMMENT_STATUS.public
          },
          select: { patch_id: true },
          distinct: ['patch_id']
        })
      ),
    invalidate: (patchIds) =>
      Promise.all(
        patchIds.map((patchId) => invalidatePatchCommentCache(patchId))
      )
  },
  // 收藏夹 → 收藏关系两级级联, 触发器递减 patch.favorite_count, 补丁详情缓存内嵌这个数 (D06-02)
  'user_patch_favorite_folder.user_id': {
    collect: async (tx, uid) =>
      patchIdsOf(
        await tx.user_patch_favorite_folder_relation.findMany({
          where: { folder: { user_id: uid } },
          select: { patch_id: true },
          distinct: ['patch_id']
        })
      ),
    invalidate: (patchIds) => invalidatePatchContentCacheByPatchId(patchIds)
  }
} satisfies Partial<Record<CascadedUserReference, CascadeProjection>>

const countRemaining = async (db: PurgeCountDb, uid: number) => {
  const remaining: AdminUserDeletionRemaining = {}
  for (const ref of ACCOUNT_PURGE_ORDER) {
    const count = await ACCOUNT_PURGERS[ref].remaining(db, uid)
    if (count > 0) {
      remaining[ref] = count
    }
  }
  return remaining
}

const isCleared = (remaining: AdminUserDeletionRemaining) =>
  Object.keys(remaining).length === 0

// 按顺序逐类清除。全部清完返回 null; 超出预算时返回各类还剩的行数
const purgeAccountContent = async (
  targetUid: number,
  actor: KunActor,
  deadline: number
): Promise<AdminUserDeletionRemaining | null> => {
  for (const ref of ACCOUNT_PURGE_ORDER) {
    let previous: number[] = []
    for (;;) {
      if (Date.now() >= deadline) {
        const remaining = await countRemaining(prisma, targetUid)
        return isCleared(remaining) ? null : remaining
      }
      const ids = await ACCOUNT_PURGERS[ref].step({
        targetUid,
        actor,
        deadline
      })
      if (!ids.length) {
        break
      }
      // 一批已被并发删掉时服务返回字符串、不报错, 下一批自然换了一组 id; 连着两批完全相同,
      // 说明服务既没删掉也没报错, 再转下去就是死循环
      if (
        ids.length === previous.length &&
        ids.every((id, index) => id === previous[index])
      ) {
        throw new Error(
          `[deleteAccount] ${ref} 的清除没有进展: ${ids.join(', ')}`
        )
      }
      previous = ids
    }
  }
  return null
}

interface DeletedUserSnapshot {
  id: number
  name: string
  email: string
  role: number
  status: number
}

const finalizeAccountDeletion = (user: DeletedUserSnapshot, actor: KunActor) =>
  kunTx(
    'account.delete.finalize',
    async (ctx) => {
      const { tx } = ctx
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM "user" WHERE id = ${user.id} FOR UPDATE`
      if (!locked.length) {
        ctx.fail('未找到用户')
      }

      // 锁下还有残余: 不写任何东西, 回到清除步骤
      const remaining = await countRemaining(tx, user.id)
      if (!isCleared(remaining)) {
        return { remaining }
      }

      for (const [ref, projection] of Object.entries(CASCADE_PROJECTIONS)) {
        const patchIds = await projection.collect(tx, user.id)
        if (!patchIds.length) {
          continue
        }
        if ('changes' in projection) {
          recordKunChanges(ctx, projection.changes(patchIds))
        } else {
          ctx.afterCommit(`cascade:${ref}`, () =>
            projection.invalidate(patchIds)
          )
        }
      }

      // 正式头像 key 是 uid 的纯函数 (X06-04)。封禁之后不会再有新的上传, 但在途的写入 (开审核时
      // worker 在裁决事务之前就把暂存对象复制过去, 不开审核时上传直接写正式 key) 若落在出箱消费
      // 之后, 对象会留下来; 两个小 avif, 接受。审核留档 (moderation/ 前缀) 按 _upload.ts 的永久
      // 保留裁定不动
      await enqueueS3Deletion(tx, Object.values(getUserAvatarKeys(user.id)))
      await tx.user.delete({ where: { id: user.id } })
      await tx.admin_log.create({
        data: {
          type: 'delete',
          user_id: actor.uid,
          content: `管理员 ${actor.name} 删除了一个用户\n\n${JSON.stringify(user)}`
        }
      })

      ctx.afterCommit('s3DeletionKick', () => kickS3DeletionDrain())
      // 会话在封禁那一步已经删光, 这里只是清理收尾: 失败只记日志
      ctx.afterCommit('securityEvent', () =>
        finishKunSecurityEvent(user.id, 'account-deleted')
      )
      return { remaining: null }
    },
    // 默认隔离级别 (READ COMMITTED): 锁下的计数每条语句取新快照, 看得到等锁期间提交的行。
    // 超时不用默认的 5 秒: 级联的量可以很大, 生产副本上回滚事务内实测, 一个用户的 12,147 条
    // 收藏关系 (每行经触发器改一次 patch.favorite_count) 删了 2.2 秒, user 1 的 39.7 万条站内信
    // 2.1 秒, 本机速度还会有约 3 倍的波动
    { retry: 2, timeout: 60_000 }
  )

export const deleteAccount = async (
  targetUid: number,
  actor: KunActor,
  options: { budgetMs?: number } = {}
): Promise<AdminUserDeletionResult | string> => {
  const user = await prisma.user.findUnique({
    where: { id: targetUid },
    select: { id: true, name: true, email: true, role: true, status: true }
  })
  if (!user) {
    return '未找到用户'
  }
  if (targetUid === actor.uid) {
    return '请勿删除自己'
  }

  const banned = await kunTx('account.delete.ban', async (ctx) => {
    const { count } = await applyKunCredentialChange(ctx.tx, {
      uid: targetUid,
      event: 'account-deletion-started',
      data: { status: 2 }
    })
    if (!count) {
      ctx.fail('未找到用户')
    }
    // 每次请求 (含续删) 记一条, 快照取自这次请求开始时
    await ctx.tx.admin_log.create({
      data: {
        type: 'delete',
        user_id: actor.uid,
        content: `管理员 ${actor.name} 开始删除一个用户 (先封禁, 再分批清除其内容)\n\n${JSON.stringify(user)}`
      }
    })
  })
  if (typeof banned === 'string') {
    return banned
  }
  // 删会话失败照常往外抛: 会话还活着就不开始删内容
  await finishKunSecurityEvent(targetUid, 'account-deletion-started')

  const deadline = Date.now() + (options.budgetMs ?? ACCOUNT_DELETION_BUDGET_MS)
  let remaining: AdminUserDeletionRemaining = {}
  for (let round = 0; round < ACCOUNT_FINALIZE_ROUNDS; round++) {
    const pending = await purgeAccountContent(targetUid, actor, deadline)
    if (pending) {
      return { done: false, remaining: pending }
    }
    const finalized = await finalizeAccountDeletion(user, actor)
    if (typeof finalized === 'string') {
      return finalized
    }
    if (!finalized.remaining) {
      return { done: true }
    }
    remaining = finalized.remaining
  }
  return { done: false, remaining }
}
