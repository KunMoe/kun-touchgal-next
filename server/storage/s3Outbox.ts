import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { deleteFileFromS3 } from '~/lib/s3'
import { withTaskLock } from '~/server/tasks/withTaskLock'
import { isS3ObjectReferenced } from './references'

const OUTBOX_DRAIN_BATCH_SIZE = 200
const OUTBOX_LOCK_KEY = 's3:deletion:outbox:lock'
const OUTBOX_LOCK_TTL_SECONDS = 300

// 删除写出箱入队：把待删除的 S3 key 持久化到出箱。client 传业务行删除所在事务的 tx，
// 使入队与删除原子提交——提交后即便进程崩溃，删除意图也已落库，由 worker 兜底删除，
// 关闭原「提交后 Promise.all 删 S3、崩溃即丢失内存中 key」的不可恢复窗口。
// 同 key 重复入队合并为一行，并从 seq 列的全局序列取新值 (新插入由列默认值取)：消费者按
// (s3_key, seq) 删行，处理期间到达的入队不会被这一轮的删行带走 (见 drain 的注释)。updated
// 是 @updatedAt (应用层维护，原生 SQL 必须显式赋值)，时间写 UTC 墙钟与 Prisma 一致；
// 形状照抄 enqueueSearchOutboxBatch。
// delayMs: 这么久之后才可以删 (not_before), 不传即立即。同一 key 重复入队取更早的时刻、立即优先:
// 合并只会让删除提前, 不会推迟一个已经要求立即删除的对象。时刻在库里按 UTC 墙钟算 (不传 JS Date,
// 原生 SQL 的 Date 参数与无时区列的换算见 prisma-pg-timestamptz 的坑)
export const enqueueS3Deletion = async (
  client: Prisma.TransactionClient,
  keys: string[],
  options: { delayMs?: number } = {}
) => {
  if (keys.length === 0) {
    return
  }
  // 去重防同语句二次命中同行（21000 直接炸事务）；排序统一锁序，与并发入队互不死锁
  const uniqueKeys = [...new Set(keys)].sort()
  const delayMs = options.delayMs ?? null
  await client.$executeRaw`
    INSERT INTO s3_deletion_outbox (s3_key, not_before, created, updated)
    SELECT unnest(${uniqueKeys}::text[]),
      (now() AT TIME ZONE 'UTC') + ${delayMs}::bigint * interval '1 millisecond',
      now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
    ON CONFLICT (s3_key) DO UPDATE
      SET seq = nextval(pg_get_serial_sequence('s3_deletion_outbox', 'seq')),
        not_before = CASE
          WHEN s3_deletion_outbox.not_before IS NULL
            OR EXCLUDED.not_before IS NULL THEN NULL
          ELSE LEAST(s3_deletion_outbox.not_before, EXCLUDED.not_before)
        END,
        updated = now() AT TIME ZONE 'UTC'`
}

// 单一消费者：加锁保证任意时刻只有一个 drain 在跑（即时 kick 与定时任务共用同锁）。
// 出箱的一行是删除候选：先向数据库确认对象已无引用 (isS3ObjectReferenced) 才 DeleteObject
// （幂等）；仍被引用就不删对象，只删这一行。两种情况都按 (s3_key, seq) 删行：判定之后若有
// 事务删掉最后一个持有者并重新入队，seq 已变，这一行留到下一轮重判；只按 s3_key 删的话，
// 那次入队被合并吞掉，对象再无引用也再无出箱行，成为永久孤儿。删行若撞上那个事务未提交的
// 行锁，会等它提交后按新 seq 重新判定，同样不命中。
// 点查不加锁：引用集合只会原子地「非空 → 非空」或「非空 → 空」(写入不变量见 references.ts)。
// 两个 drain 并发 (续锁失败、锁键被逐出) 时各自点查、幂等删除、CAS 删行：seq 取自全局序列、
// 永不重复，一个 drain 删掉行之后重新插入的行不会被另一个按旧读数删掉。
// 删除失败累加 attempts 并滞留，等下一轮重试——至少一次投递。
export const drainS3DeletionOutbox = async () =>
  withTaskLock(
    {
      key: OUTBOX_LOCK_KEY,
      ttlSeconds: OUTBOX_LOCK_TTL_SECONDS,
      taskName: 's3DeletionOutboxDrain'
    },
    async (renew) => {
      // 还没到时刻的行 (宽限期里的旧封面版本) 留在出箱里, 不占这一轮的名额
      const now = new Date()
      const rows = await prisma.s3_deletion_outbox.findMany({
        where: { OR: [{ not_before: null }, { not_before: { lte: now } }] },
        orderBy: { updated: 'asc' },
        take: OUTBOX_DRAIN_BATCH_SIZE,
        select: { s3_key: true, seq: true }
      })

      let deleted = 0
      let skippedReferenced = 0
      for (const row of rows) {
        try {
          if (await isS3ObjectReferenced(prisma, row.s3_key)) {
            // 历史共享对象 (重复提交留下的同 key 资源)、重复提交的同一 link id、提交响应
            // 丢失后的 abandon、commit 结果不确定时回收的封面新版本都会走到这里
            // eslint-disable-next-line no-console
            console.warn(
              `S3 删除写出箱跳过 ${row.s3_key}：仍被资源链接或封面指针引用，只移除出箱行`
            )
            skippedReferenced++
          } else {
            await deleteFileFromS3(row.s3_key)
            deleted++
          }
          await prisma.s3_deletion_outbox.deleteMany({
            where: { s3_key: row.s3_key, seq: row.seq }
          })
        } catch (error) {
          // 失败不删行、累加 attempts 待下一轮重试。updateMany 会隐式刷新 @updatedAt，
          // 使失败行在 orderBy(updated asc) 中沉到队尾——反复失败的行不会卡队头阻塞新
          // 入队行 (search_outbox 被拒时同样记 attempts 并顺带沉底，另有退避与隔离；此处
          // 只累加次数，得到「最久未重试优先」的沉底调度，无饥饿)
          await prisma.s3_deletion_outbox
            .updateMany({
              where: { s3_key: row.s3_key },
              data: { attempts: { increment: 1 } }
            })
            .catch(() => undefined)
          console.error(
            `S3 删除写出箱处理 ${row.s3_key} 失败，保留待下轮重试:`,
            error
          )
        }
        // 每处理一行续锁：drain 活跃期间租约不过期，杜绝锁 TTL 过期后第二个 drain 并发
        await renew()
      }
      return { deleted, skippedReferenced }
    }
  )

// 即时消费：入队后立刻尝试 drain 一次，保持近实时删除；抢不到锁则由定时任务兜底。
export const kickS3DeletionDrain = () => {
  void drainS3DeletionOutbox().catch((error) => {
    console.error('S3 删除写出箱即时消费失败:', error)
  })
}
