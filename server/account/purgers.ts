import { prisma } from '~/prisma/index'
import { deletePatchById } from '~/app/api/patch/delete'
import { deleteResource } from '~/app/api/admin/resource/delete'
import { deleteComment } from '~/app/api/admin/comment/delete'
import { deleteRating } from '~/app/api/admin/rating/delete'
import {
  ADMIN_COMMENT_DELETE_LIMIT,
  ADMIN_RATING_DELETE_LIMIT,
  ADMIN_RESOURCE_DELETE_LIMIT
} from '~/constants/admin'
import { Prisma } from '~/prisma/generated/prisma/client'
import type { KunActor } from '~/constants/role'
import type { PurgedUserReference } from './userReferences'

// 归为 purge 的引用各自的清除器。清除只调现成的删除服务, 副作用 (S3 出箱、搜索出箱、审核
// 任务与申诉、举报、评论通知、计数与聚合重算、缓存) 都随服务发生; 今后对这些服务的修复自动
// 覆盖删号, 这里不再手抄任何清理序列。把一条引用归为 purge 却不在这里写清除器, typecheck 报错。
//
// step 按 id 升序取一批并删掉, 返回实际处理过的 id (空数组表示已清完)。服务返回字符串 (这批已被
// 并发删掉) 时不报错, 下一轮重查即可。deadline 是这次请求的预算截止时刻, 慢的清除器在批内也看它。
// 清除器调用的服务都不锁 user 行: 被删用户的 user 行只由收尾事务锁 (见 deleteAccount.ts)
export type PurgeCountDb = Pick<
  Prisma.TransactionClient,
  'patch' | 'patch_resource' | 'patch_comment' | 'patch_rating'
>

export interface AccountPurger {
  // 还有多少行指向该用户。收尾时在 user 行锁下调用
  remaining(db: PurgeCountDb, uid: number): Promise<number>
  step(ctx: {
    targetUid: number
    actor: KunActor
    deadline: number
  }): Promise<number[]>
}

// 删游戏逐个调用 deletePatchById, 每个游戏连同其下全部资源、评论与评价是一个事务, 比批量删
// 资源慢得多 (生产副本上最重的游戏, 6,127 条收藏、735 条评论, 级联本身 0.87 秒): 一批取得少,
// 批内每删一个还看一次预算
const PATCH_PURGE_BATCH = 10

// 并发的另一个删号请求 (504 之后重点、两位管理员同时删) 已经删掉这个游戏: deletePatchById 事务外
// 的预检还看得到它, 事务内的 patch.delete 等到锁后命中 0 行抛 P2025。与其余服务返回字符串同义
const deletePatchIfPresent = async (patchId: number) => {
  try {
    await deletePatchById({ patchId })
  } catch (error) {
    if (!(
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    )) {
      throw error
    }
  }
}

const idsOf = (rows: Array<{ id: number }>) => rows.map((row) => row.id)

export const ACCOUNT_PURGERS: Record<PurgedUserReference, AccountPurger> = {
  'patch.user_id': {
    remaining: (db, uid) => db.patch.count({ where: { user_id: uid } }),
    step: async ({ targetUid, deadline }) => {
      const ids = idsOf(
        await prisma.patch.findMany({
          where: { user_id: targetUid },
          orderBy: { id: 'asc' },
          take: PATCH_PURGE_BATCH,
          select: { id: true }
        })
      )
      const handled: number[] = []
      for (const patchId of ids) {
        // 至少删一个再看预算, 每次请求都有进展
        if (handled.length && Date.now() >= deadline) {
          break
        }
        await deletePatchIfPresent(patchId)
        handled.push(patchId)
      }
      return handled
    }
  },
  'patch_resource.user_id': {
    remaining: (db, uid) =>
      db.patch_resource.count({ where: { user_id: uid } }),
    step: async ({ targetUid, actor }) => {
      const ids = idsOf(
        await prisma.patch_resource.findMany({
          where: { user_id: targetUid },
          orderBy: { id: 'asc' },
          take: ADMIN_RESOURCE_DELETE_LIMIT,
          select: { id: true }
        })
      )
      if (ids.length) {
        await deleteResource({ resourceIds: ids }, actor.uid)
      }
      return ids
    }
  },
  'patch_comment.user_id': {
    remaining: (db, uid) => db.patch_comment.count({ where: { user_id: uid } }),
    step: async ({ targetUid, actor }) => {
      const ids = idsOf(
        await prisma.patch_comment.findMany({
          where: { user_id: targetUid },
          orderBy: { id: 'asc' },
          take: ADMIN_COMMENT_DELETE_LIMIT,
          select: { id: true }
        })
      )
      if (ids.length) {
        await deleteComment({ commentIds: ids }, actor.uid)
      }
      return ids
    }
  },
  'patch_rating.user_id': {
    remaining: (db, uid) => db.patch_rating.count({ where: { user_id: uid } }),
    step: async ({ targetUid, actor }) => {
      const ids = idsOf(
        await prisma.patch_rating.findMany({
          where: { user_id: targetUid },
          orderBy: { id: 'asc' },
          take: ADMIN_RATING_DELETE_LIMIT,
          select: { id: true }
        })
      )
      if (ids.length) {
        await deleteRating({ ratingIds: ids }, actor.uid)
      }
      return ids
    }
  }
}

// 清除顺序: 游戏先删, 它会连带删掉该用户挂在自己游戏下的资源、评论与评价, 后面几类就只剩
// 挂在别人游戏下的部分; 资源先于评论, 资源评论随资源一起清
export const ACCOUNT_PURGE_ORDER = [
  'patch.user_id',
  'patch_resource.user_id',
  'patch_comment.user_id',
  'patch_rating.user_id'
] as const satisfies readonly PurgedUserReference[]
