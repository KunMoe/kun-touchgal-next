import { randomBytes } from 'crypto'
import { deleteFileFromS3 } from '~/lib/s3'
import { acquireKvLock, releaseKvLock } from '~/lib/redis'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { lockPatchRows } from '~/server/content/patchLock'
import type { Prisma } from '~/prisma/generated/prisma/client'
import {
  enqueueS3Deletion,
  kickS3DeletionDrain
} from '~/server/storage/s3Outbox'
import {
  consumeStagedUpload,
  discardStagedUpload,
  promoteStagedObject,
  readUploadToken,
  verifyStagedObject
} from '~/server/storage/stagedUpload'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import { recordKunChanges } from '~/server/cache/publish'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import {
  RESOURCE_DAILY_UPLOAD_LIMIT_MB,
  RESOURCE_S3_COPY_TIMEOUT_MS,
  RESOURCE_S3_HEAD_TIMEOUT_MS
} from '~/constants/resource'

// 锁要盖住锁内全部带墙钟上限的 S3 调用: 暂存对象的 HEAD、复制、转正后的 HEAD, 任何一个
// 上限调大, 租期跟着变。另加的 15 秒是给 Redis 与额度更新的余量, 这两步自己没有墙钟上限
// (额度更新可能要等 user 行锁): 租期到了绑定还没走完时, 同一枚令牌的另一次绑定进得来,
// 那时由 consumeStagedUpload 对令牌的原子认领保证只有一次转正算数
const BIND_LOCK_TTL_SECONDS =
  Math.ceil(
    (RESOURCE_S3_COPY_TIMEOUT_MS + 2 * RESOURCE_S3_HEAD_TIMEOUT_MS) / 1000
  ) + 15

export const bindUploadedResource = async (
  patchId: number,
  token: string,
  uid: number
) => {
  const lockKey = `upload-bind:${token}`
  const lockToken = await acquireKvLock(lockKey, BIND_LOCK_TTL_SECONDS)
  if (!lockToken) {
    return '该上传 token 正在被处理, 请稍后再试'
  }

  try {
    const meta = await readUploadToken(token, uid)
    if (typeof meta === 'string') {
      return meta
    }
    const verified = await verifyStagedObject(token, meta)
    if (typeof verified === 'string') {
      return verified
    }
    const actualSize = verified.size
    const fileSizeMB = Number((actualSize / (1024 * 1024)).toFixed(3))
    const quota = await prisma.user.updateMany({
      where: {
        id: uid,
        daily_upload_size: {
          lte: RESOURCE_DAILY_UPLOAD_LIMIT_MB - fileSizeMB
        }
      },
      data: { daily_upload_size: { increment: fileSizeMB } }
    })
    if (quota.count === 0) {
      await discardStagedUpload(token, meta)
      return '您今日的上传大小已达到 5GB 限额'
    }

    const segment = randomBytes(32).toString('hex')
    const finalKey = `patch/${patchId}/resource/${segment}/${meta.fileName}`
    try {
      await promoteStagedObject(meta, finalKey)
      await consumeStagedUpload(token, meta)
    } catch (error) {
      // 复制结果不确定：S3 可能已完成 CopyObject 但响应超时/中断，留下无 DB 引用的
      // finalKey 孤儿 (随机段, 重试会生成新 key 使其永久泄漏)。DeleteObject 幂等
      // (未创建则 no-op)：即时清理；即时删除亦失败时入删除写出箱由 worker 兜底重试
      await deleteFileFromS3(finalKey).catch(() =>
        enqueueS3Deletion(prisma, [finalKey]).catch(() => undefined)
      )
      await prisma.user
        .updateMany({
          where: {
            id: uid,
            daily_upload_size: { gte: fileSizeMB }
          },
          data: { daily_upload_size: { decrement: fileSizeMB } }
        })
        .catch(() => undefined)
      throw error
    }
    await invalidateUserSession(uid)

    const downloadLink = `${process.env.NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL!}/${finalKey}`
    return { downloadLink, s3Key: finalKey, size: actualSize }
  } finally {
    await releaseKvLock(lockKey, lockToken).catch(() => undefined)
  }
}

// 解析资源链接对应的 S3 对象 key：优先用持久化的 s3_key，缺失则回落 legacy 命名
// (早期未存 s3_key 的历史数据)。返回 null 表示无法定位对象 (content 异常)。
export const resolveS3Key = (
  content: string,
  patchId: number,
  hash: string,
  s3Key?: string
): string | null => {
  if (s3Key) {
    return s3Key
  }

  const fileName = content.split('/').pop()
  if (!fileName) {
    return null
  }
  return `patch/${patchId}/resource/${hash}/${fileName}`
}

// 把一批资源链接的 S3 key 解析后入删除写出箱。client 传业务删除所在事务的 tx，使
// 删除意图与行删除原子提交——取代原「提交后 Promise.all 删 S3、崩溃即丢失」的不可
// 恢复路径；实际删除交由单一消费者 drainS3DeletionOutbox 幂等重试。
// 删除资源前调用 (评论行尚存时): FK 级联只会删掉该资源评论的 patch_comment 行,
// 评论区站内信 (评论/点赞/提及, link 均为资源页 ?commentId= 前缀)、
// 待裁决审核任务与申诉不会随级联清理, 须在此显式删除。
// 评论举报外键是 SET NULL: 调用方须在资源行删除后 deleteOrphanReports('comment')
// 清理级联置空的孤儿 (保持全站「内容行→举报行」锁序)
// 接受 id 数组: 管理端批量删除在一个事务里清理整批, 三条语句取代逐资源 N+1
// (user_message.link 无索引, 前缀删除是全表扫描, 合并成一条 OR 只扫一遍)
export const cleanupResourceCommentDerivatives = async (
  tx: Prisma.TransactionClient,
  resourceId: number | number[]
) => {
  const resourceIds = Array.isArray(resourceId) ? resourceId : [resourceId]
  const resources = await tx.patch_resource.findMany({
    where: { id: { in: resourceIds }, comment: { some: {} } },
    select: {
      id: true,
      patch: { select: { unique_id: true } },
      comment: { select: { id: true } }
    }
  })
  if (resources.length === 0) {
    return
  }

  const commentIds = resources.flatMap((resource) =>
    resource.comment.map((comment) => comment.id)
  )
  await tx.user_message.deleteMany({
    where: {
      OR: resources.map((resource) => ({
        link: {
          startsWith: `/${resource.patch.unique_id}/resource/${resource.id}?commentId=`
        }
      }))
    }
  })
  await deletePendingModerationTasks('comment', commentIds, tx)
  await deletePendingAppeals('comment', commentIds, tx)
}

export const enqueueResourceLinkDeletions = async (
  client: Prisma.TransactionClient,
  links: {
    content: string
    patchId: number
    hash: string
    s3Key?: string
  }[]
) => {
  const keys = links
    .map((link) =>
      resolveS3Key(link.content, link.patchId, link.hash, link.s3Key)
    )
    .filter((key): key is string => key !== null)
  await enqueueS3Deletion(client, keys)
}

// bind 成功后未落库即失败 (阶段一早退 / 事务回滚): 已复制的 finalKey 无 DB 引用,
// staging 与 token 已删使重试无法复用, 随机段无法重建, 不清理即成永久孤儿
// (正式资源同前缀, 不能靠 lifecycle 兜底). 用顶层 prisma 入删除出箱后即时踢 drain,
// 与 update 事务内冲突分支的清理对称; 入队失败自吞, 不遮蔽调用方正在返回的业务错误
export const abandonBoundResourceObjects = async (
  bound: Array<{ content: string; s3Key: string }>,
  patchId: number
) => {
  if (bound.length === 0) {
    return
  }
  try {
    await enqueueResourceLinkDeletions(
      prisma,
      bound.map((item) => ({
        content: item.content,
        patchId,
        hash: '',
        s3Key: item.s3Key
      }))
    )
  } catch {
    return
  }
  kickS3DeletionDrain()
}

export const sanitizeResourceLinksForAuditLog = <
  L extends {
    content?: string
    password?: string
    code?: string
    hash?: string
    s3_key?: string
  }
>(
  links: L[] | undefined | null
): Omit<L, 'content' | 'password' | 'code' | 'hash' | 's3_key'>[] => {
  if (!links) {
    return []
  }
  return links.map(({ content, password, code, hash, s3_key, ...rest }) => rest)
}

// 通告锁命名空间 (pg_advisory_xact_lock 首参): 同一 patch 的并发重算按 (域, patchId)
// 串行, 与评分统计锁 (rating stat) 分属不同域, 互不阻塞
const PATCH_TYPE_LOCK_NAMESPACE = 481001

const recalcPatchTypeLocked = async (
  patchId: number,
  tx: Prisma.TransactionClient
): Promise<string> => {
  // pg_advisory_xact_lock: 事务级通告锁, 提交/回滚时自动释放. 使同一 patch 的
  // 「读全部可见资源 → 写 type/language/platform」原子化, 消除重叠事务 (审核重叠批次、
  // 管理员与用户并发操作) 的丢更新. 用 $executeRaw (而非 $queryRaw): pg adapter 无法
  // 反序列化 void 返回列; ::int 显式定型以匹配 (int, int) 重载.
  // 取通告锁之前先锁 patch 行: 调用方若在此之前改过资源的 status / 删过公开资源, 计数
  // 触发器已经拿到 patch 行锁; 本函数若先取通告锁、到末尾的 UPDATE 才碰 patch 行, 两条
  // 路径就在「patch 行」与「通告锁」上反序互等. 统一成 patch 行 → 通告锁
  await lockPatchRows(tx, [patchId])
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PATCH_TYPE_LOCK_NAMESPACE}::int, ${patchId}::int)`

  const resources = await tx.patch_resource.findMany({
    where: { patch_id: patchId, status: 0 },
    select: { type: true, language: true, platform: true }
  })

  const types = [...new Set(resources.flatMap((r) => r.type))]
  const languages = [...new Set(resources.flatMap((r) => r.language))]
  const platforms = [...new Set(resources.flatMap((r) => r.platform))]

  const patch = await tx.patch.update({
    where: { id: patchId },
    data: {
      type: { set: types },
      language: { set: languages },
      platform: { set: platforms }
    },
    select: { unique_id: true }
  })

  // 缓存失效移出事务: 事务内删 Redis 会 (1) 提交前失效、并发读回填旧值、提交后无二次
  // 删致旧值滞留至 TTL; (2) Redis 故障回滚本应只依赖 PostgreSQL 的写入. 返回 unique_id
  // 交由调用方在事务提交后 best-effort 失效
  return patch.unique_id
}

// 现有调用方全部在事务内 (审核 apply / 申诉 / 资源增删改 / 管理端), 传入其 tx: 锁随该
// 事务提交释放, 且重算参与调用方事务、能见其未提交的资源改动. 不传 tx 时自开事务兜底.
// 两个易错点: (1) 交互事务客户端运行期仍带 $transaction 属性, 故不能用 'in' 判据区分,
// 只能判 tx 是否传入. (2) tx 必须是交互事务客户端; 顶层 prisma 虽能过类型检查 (结构
// 超集), 但会让通告锁跑在 autocommit 连接上、语句结束即释放 → 序列化静默失效, 切勿传入
export const recalcPatchType = async (
  patchId: number,
  tx?: Prisma.TransactionClient
): Promise<string> => {
  if (!tx) {
    // 不传 tx 的兜底: 自开事务, 提交后再失效缓存 (与传 tx 时调用方报告的 patch 变更等价)
    const result = await kunTx('patch.recalcType', async (ctx) => {
      const uniqueId = await recalcPatchTypeLocked(patchId, ctx.tx)
      recordKunChanges(ctx, [{ kind: 'patch', patchId, uniqueId }])
      return { uniqueId }
    })
    // 回调里没有 fail, 走不到字符串结果
    if (typeof result === 'string') {
      throw new Error(result)
    }
    return result.uniqueId
  }
  // 传 tx: 返回 unique_id, 调用方用它报告 patch 变更 (recordKunChanges), 由规划器在提交后失效
  return recalcPatchTypeLocked(patchId, tx)
}
