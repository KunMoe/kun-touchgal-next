import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { getMeiliClient } from '~/lib/meilisearch'
import { withTaskLock } from '~/server/tasks/withTaskLock'
import { GALGAME_INDEX } from './settings'
import { PATCH_SEARCH_SELECT, patchToSearchDoc } from './document'

// 单文档实时同步的任务等待上限；超时即抛错，令写出箱保留该行等待下一轮消费
const SEARCH_SYNC_TASK_TIMEOUT_MS = 30_000
const OUTBOX_DRAIN_BATCH_SIZE = 200
const OUTBOX_LOCK_KEY = 'search:outbox:lock'
const OUTBOX_LOCK_TTL_SECONDS = 300

// 低层应用器：按 patchId 读取补丁最新状态后写入 Meilisearch —— 存在则 upsert 文档，
// 已删除则删除索引文档。必须 waitTask 等到任务终态：SDK 的 addDocuments/deleteDocument
// 仅返回“已入队”任务，后台处理失败不会 reject；不等终态会把静默失败误判为成功、
// 使删除/更新永久停留在陈旧值（搜索卡片直接取索引文档，用户可见）。
export const syncPatchToSearch = async (patchId: number) => {
  const client = getMeiliClient()
  if (!client) {
    return
  }
  const index = client.index(GALGAME_INDEX)

  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    select: PATCH_SEARCH_SELECT
  })

  if (!patch) {
    const task = await index
      .deleteDocument(patchId)
      .waitTask({ timeout: SEARCH_SYNC_TASK_TIMEOUT_MS })
    if (task.status !== 'succeeded') {
      throw new Error(
        `搜索索引删除 patch ${patchId} 失败: ${JSON.stringify(task.error)}`
      )
    }
    return
  }

  const doc = await patchToSearchDoc(patch)
  const task = await index
    .addDocuments([doc])
    .waitTask({ timeout: SEARCH_SYNC_TASK_TIMEOUT_MS })
  if (task.status !== 'succeeded') {
    throw new Error(
      `搜索索引同步 patch ${patchId} 失败: ${JSON.stringify(task.error)}`
    )
  }
}

// 写出箱入队：每个 patch 至多一行待同步意图，每次入队都换发 seq 作为认领令牌 (见批量版)。
// 单一 worker 串行消费 + 应用器读取最新状态，从根本上消除并发写的反序覆盖：
// 无论多少次并发变更，同一 patch 最终只会被读到“当前”状态并写入。
// client 传业务写所在事务的 tx，使入队与补丁变更原子提交（C-full，关闭“提交后再
// 入队”的崩溃丢失窗口）；传顶层 prisma 则独立自动提交（queueSearchSync 兜底路径）。
export const enqueueSearchOutbox = async (
  client: Prisma.TransactionClient,
  patchId: number
) => {
  await enqueueSearchOutboxBatch(client, [patchId])
}

// 批量入队：标签/会社改名或删除会波及其下全部关联 patch（热门标签可达数百上千），
// 逐条 upsert 的往返次数会打满交互事务超时，故单条 SQL 完成整批。updated 是
// @updatedAt（应用层维护，原生 SQL 必须显式赋值），时间写 UTC 墙钟与 Prisma 一致。
// seq 新插入由列默认值、冲突时显式从同一个全局序列取值，永不重复：从 0 起计、冲突加 1 的话，
// 一个 drain 删掉 (P, 0) 之后重新插入的行又是 (P, 0)，并发的第二个 drain (续锁失败) 会按
// 旧读数把它删掉，那次变更就不再同步
export const enqueueSearchOutboxBatch = async (
  client: Prisma.TransactionClient,
  patchIds: number[]
) => {
  if (patchIds.length === 0) {
    return
  }
  // 去重防同语句二次命中同行（21000 直接炸事务）；升序统一锁序，与并发的
  // 批量/循环入队互不死锁（项目惯例：批内加锁一律升序）
  const ids = [...new Set(patchIds)].sort((a, b) => a - b)
  await client.$executeRaw`
    INSERT INTO search_outbox (patch_id, created, updated)
    SELECT unnest(${ids}::int[]),
      now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
    ON CONFLICT (patch_id) DO UPDATE
      SET seq = nextval(pg_get_serial_sequence('search_outbox', 'seq')),
        updated = now() AT TIME ZONE 'UTC'`
}

// 单一消费者：加锁保证任意时刻只有一个 drain 在跑（即时 kick 与定时任务共用同锁），
// 杜绝两个应用器并发写同一索引。逐行读取最新状态后应用，成功才按 (patch_id, seq)
// 条件删除——若处理期间有并发入队使 seq 变化，则条件不命中、该行滞留等待下一轮，
// 不丢失新变更。应用失败同样滞留，取代原 Redis search:retry 重试集。
export const drainSearchOutbox = async () => {
  if (!getMeiliClient()) {
    return
  }

  await withTaskLock(
    {
      key: OUTBOX_LOCK_KEY,
      ttlSeconds: OUTBOX_LOCK_TTL_SECONDS,
      taskName: 'searchOutboxDrain'
    },
    async (renew) => {
      const rows = await prisma.search_outbox.findMany({
        orderBy: { updated: 'asc' },
        take: OUTBOX_DRAIN_BATCH_SIZE,
        select: { patch_id: true, seq: true }
      })

      for (const row of rows) {
        try {
          await syncPatchToSearch(row.patch_id)
          await prisma.search_outbox.deleteMany({
            where: { patch_id: row.patch_id, seq: row.seq }
          })
        } catch (error) {
          console.error(
            `搜索写出箱同步 patch ${row.patch_id} 失败，保留待下轮重试:`,
            error
          )
        }
        // 每处理一行续锁：只要 drain 活跃（单行 waitTask ≤30s ≪ 300s TTL）租约不
        // 过期，杜绝「锁 TTL 过期 → 第二个 drain 并发 → 按 Meili 任务入队序写乱 →
        // 旧文档覆盖新文档」；worker 崩溃则停止续锁、锁 300s 后自动释放交予下一轮
        await renew()
      }
    }
  )
}

// 即时消费：入队后立刻尝试 drain 一次，保持近实时同步；抢不到锁则由定时任务兜底。
const kickDrain = () => {
  void drainSearchOutbox().catch((error) => {
    console.error('搜索写出箱即时消费失败:', error)
  })
}

// 仅触发即时消费、不入队：供已在事务内 enqueueSearchOutbox 的 C-full 调用点在事务
// 提交后调用，避免事务后再重复 upsert（seq 空转 + re-dirty updated 扰乱排序）；
// 批量场景一次 kick 即可，drain 会处理整箱、无需逐 patch 各 kick 一次。
export const kickSearchOutboxDrain = () => {
  if (!getMeiliClient()) {
    return
  }
  kickDrain()
}

// 写路径出口在事务成功后调用；入队与即时消费均 fire-and-forget，绝不阻塞主业务。
// 只要配置了引擎就保持索引新鲜，KUN_MEILISEARCH_ENABLED 仅控制查询路径。
// 增删共用同一入口：应用器据补丁当前是否存在决定 upsert 或删除，因此删除也走此函数。
const queueSearchOutbox = (patchId: number) => {
  if (!getMeiliClient()) {
    return
  }
  void enqueueSearchOutbox(prisma, patchId)
    .then(kickDrain)
    .catch((error) => {
      console.error(`patch ${patchId} 入搜索写出箱失败:`, error)
    })
}

export const queueSearchSync = queueSearchOutbox
export const queueSearchRemove = queueSearchOutbox
