import { prisma } from '~/prisma/index'
import type { KunTx } from '~/prisma/index'
import { getMeiliClient } from '~/lib/meilisearch'
import { classifyHttpStatus } from '~/lib/resilience/failure'
import { withJobLease } from '~/server/jobs/lease'
import { sliceCodePoints } from '~/utils/text/unicode'
import { MeiliProtocolError } from './failure'
import { GALGAME_INDEX } from './settings'
import {
  PATCH_SEARCH_SELECT,
  patchToSearchDoc,
  type GalgameSearchCountsDoc
} from './document'

// 活索引只有这一个写者: 文档的增删改只经 drainSearchOutbox (逐行读最新状态后写入), 计数只经
// 写锁内的 applyCounts。两者共用一把锁, 任意时刻至多一方在写; 对账 (reconcile.ts) 只读、
// 只入箱。Meilisearch 的文档写 API 只许出现在这个文件里 (lint kun/inv-search-03)

// 单文档实时同步的任务等待上限；超时按引擎不可用处理，该行留在出箱等下一轮
const SEARCH_SYNC_TASK_TIMEOUT_MS = 30_000
// 计数批次的任务等待上限
const SEARCH_COUNTS_TASK_TIMEOUT_MS = 60_000
const OUTBOX_DRAIN_BATCH_SIZE = 200
// 沿用旧的键名：发布期间新旧进程并存时仍然只有一把锁
const SEARCH_WRITER_LOCK_KEY = 'search:outbox:lock'
// 同一版内容被拒绝这么多次之后不再取 (隔离)，等应用写入再次入队或人工重试
export const SEARCH_OUTBOX_MAX_ATTEMPTS = 10
const OUTBOX_BACKOFF_BASE_MS = 60_000
const OUTBOX_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
// 引擎整体收不了写入时，撞上它的那一行往后挪这么久 (不计次数)
const OUTBOX_ENGINE_RETRY_DELAY_MS = 60_000
// 请求进程里的即时 kick 最多连续消费这么久：积压时 (整库重投影) 不在请求进程里跑整批
const KICK_DRAIN_BUDGET_MS = 2_000
// 与 search_outbox.last_error 的列宽一致
const OUTBOX_LAST_ERROR_MAX_LENGTH = 1007

// waitTask 拿到的终态不是 succeeded。task 上的错误体带 type: invalid_request 说的是这份
// 文档 (字段非法、主键非法…)，internal / system / auth 说的是引擎自己 (磁盘满、密钥不对)
export class SearchTaskFailedError extends Error {
  readonly status: string
  readonly code: string | null
  readonly type: string | null

  constructor(
    message: string,
    task: { status: string; error?: { code?: string; type?: string } | null }
  ) {
    super(`${message}: ${JSON.stringify(task.error ?? null)}`)
    this.name = 'SearchTaskFailedError'
    this.status = task.status
    this.code = task.error?.code ?? null
    this.type = task.error?.type ?? null
  }
}

// SDK 调用的边界：抛出的不是 Meilisearch 的错误，说明应答根本不是 Meilisearch 的 (地址指到了
// 别的服务：2xx 但正文不是 JSON 时 SDK 原样抛 SyntaxError，空正文时读不到 taskUid 抛 TypeError)，
// 与这份文档无关。说成 MeiliProtocolError (查询侧 query.ts 同款)，归为引擎整体收不了写入
const callMeili = async <T>(call: () => Promise<T>) => {
  try {
    return await call()
  } catch (error) {
    const { name } = shapeOf(error)
    if (typeof name === 'string' && name.startsWith('Meilisearch')) {
      throw error
    }
    throw new MeiliProtocolError('Meilisearch 写入的应答不是任务', error)
  }
}

// 低层应用器：按 patchId 读取补丁最新状态后写入 Meilisearch —— 存在则 upsert 文档，
// 已删除则删除索引文档。必须 waitTask 等到任务终态：SDK 的 addDocuments/deleteDocument
// 仅返回“已入队”任务，后台处理失败不会 reject；不等终态会把静默失败误判为成功、
// 使删除/更新永久停留在陈旧值。只由 drain 在写锁内调用 (别处导入它由 lint
// kun/inv-search-03 拦下)
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
    const task = await callMeili(() =>
      index
        .deleteDocument(patchId)
        .waitTask({ timeout: SEARCH_SYNC_TASK_TIMEOUT_MS })
    )
    if (task.status !== 'succeeded') {
      throw new SearchTaskFailedError(
        `搜索索引删除 patch ${patchId} 失败`,
        task
      )
    }
    return
  }

  const doc = await patchToSearchDoc(patch)
  const task = await callMeili(() =>
    index.addDocuments([doc]).waitTask({ timeout: SEARCH_SYNC_TASK_TIMEOUT_MS })
  )
  if (task.status !== 'succeeded') {
    throw new SearchTaskFailedError(`搜索索引同步 patch ${patchId} 失败`, task)
  }
}

const shapeOf = (error: unknown): Record<string, unknown> =>
  typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)
    : {}

// 任务错误类型虽是 invalid_request，说的却是索引本身：索引不存在，或索引没有主键 (文档写入
// 撞上不存在的索引时引擎会自动建出这样的索引，随后在 id / uniqueId / vndbId … 之间推断不出
// 主键)。换哪份文档都一样，由 pnpm search:ensure --apply 修好
const INDEX_STATE_TASK_ERRORS = new Set([
  'index_not_found',
  'index_primary_key_multiple_candidates_found',
  'index_primary_key_no_candidate_found'
])

// 这次写入失败说的是 Meilisearch 整体此刻收不了写入 (连不上、超时、5xx / 408 / 425 / 429、
// 密钥或地址不对、应答不是 Meilisearch 的、磁盘满、索引不存在或没有主键)，还是这一份文档被拒
// (请求体非法、字段非法)。前者换哪一行都一样，不算在这一行头上：引擎宕机十分钟不该把整箱行推进
// 隔离区。认不出的错误 (读 PG、构建文档时抛的) 算这一行的：这样确定性失败的那一行会退避、隔离，
// 而不是每分钟重试一次。按 name 与错误码判别，不用 instanceof (SDK 被加载成两份时恒假)
export const isEngineWideWriteFailure = (error: unknown) => {
  const { name, response, status, code, type } = shapeOf(error)
  if (name === 'MeiliProtocolError') {
    return true
  }
  if (name === 'SearchTaskFailedError') {
    return (
      status !== 'failed' ||
      type !== 'invalid_request' ||
      (typeof code === 'string' && INDEX_STATE_TASK_ERRORS.has(code))
    )
  }
  if (
    name === 'MeilisearchRequestError' ||
    name === 'MeilisearchRequestTimeOutError' ||
    name === 'MeilisearchTaskTimeOutError'
  ) {
    return true
  }
  if (name === 'MeilisearchApiError') {
    const httpStatus = shapeOf(response).status
    return (
      typeof httpStatus !== 'number' ||
      classifyHttpStatus(httpStatus) !== 'request'
    )
  }
  return false
}

const describeError = (error: unknown) => {
  const { name, message } = shapeOf(error)
  const text =
    typeof message === 'string'
      ? `${typeof name === 'string' ? name : 'Error'}: ${message}`
      : String(error)
  return sliceCodePoints(text, OUTBOX_LAST_ERROR_MAX_LENGTH)
}

// 第 n 次失败之后等 2^(n-1) 分钟，封顶 6 小时；10 次约在 8.5 小时内用完
const backoffMs = (attempts: number) =>
  Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** (attempts - 1), OUTBOX_BACKOFF_MAX_MS)

export interface SearchWriter {
  // 写锁 (心跳续租的租约, server/jobs/lease.ts) 丢失、或调用方要求停下时中止。长任务每处理
  // 一段先看它: 租约丢了还接着写, 另一个写者可能已经开始, 两边按 Meilisearch 任务入队的先后
  // 写乱 (旧文档覆盖新文档)
  signal: AbortSignal
  // 做完一段 (出箱的一行、计数的一批): 写锁的停滞看门狗重新计时 (server/jobs/lease.ts)
  progress: () => void
  // 把计数 partial 文档写进索引，返回实际写入的那些。出箱里还挂着行 (待同步或已隔离) 的 id
  // 先剔除：它们可能还不在索引里 (新建的 patch、写入一直失败的)，PUT 会为不存在的 id 建出
  // 只有计数的残缺文档；它们的计数随后由 drain 写全量文档时一并带上。漏了入箱、又不在索引里
  // 的 id 仍会被 PUT 成残缺文档，由下一次对账 (没有摘要，判为过时) 修回。引擎升到 ≥ 1.31 后
  // 改用 updateDocuments 的 skipCreation，这层剔除就可以删掉
  applyCounts: (
    docs: GalgameSearchCountsDoc[]
  ) => Promise<GalgameSearchCountsDoc[]>
}

const applyCounts = async (docs: GalgameSearchCountsDoc[]) => {
  const client = getMeiliClient()
  if (!client || docs.length === 0) {
    return []
  }
  // 持锁期间 drain 不会运行：被删的 patch 要么删除已经应用 (调用方从 PG 读不到它)，要么
  // 还挂着出箱行 (在这里被剔除)；新建的 patch 在出箱排空之前同样被剔除
  const pending = await prisma.search_outbox.findMany({
    where: { patch_id: { in: docs.map((doc) => doc.id) } },
    select: { patch_id: true }
  })
  const pendingIds = new Set(pending.map((row) => row.patch_id))
  const applicable = docs.filter((doc) => !pendingIds.has(doc.id))
  if (applicable.length === 0) {
    return []
  }
  const task = await client
    .index(GALGAME_INDEX)
    .updateDocuments(applicable)
    .waitTask({ timeout: SEARCH_COUNTS_TASK_TIMEOUT_MS })
  if (task.status !== 'succeeded') {
    throw new Error(`计数快照批次写入失败: ${JSON.stringify(task.error)}`)
  }
  return applicable
}

// 持写锁执行 fn。抢不到锁 (另一个写者正在写) 返回 undefined，调用方本轮跳过；waitMs 是锁被
// 占着时最多等多久，signal 中止时不再等、已在写的经 writer.signal 停下
export const withSearchWriter = async <T>(
  taskName: string,
  fn: (writer: SearchWriter) => Promise<T>,
  { waitMs = 0, signal }: { waitMs?: number; signal?: AbortSignal } = {}
) => {
  const result = await withJobLease(
    { name: taskName, key: SEARCH_WRITER_LOCK_KEY, waitMs, signal },
    (lease) =>
      fn({ signal: lease.signal, progress: lease.progress, applyCounts })
  )
  return result.ran ? result.value : undefined
}

type EnqueueMode = 'write' | 'reconcile'

// 写出箱入队：每个 patch 至多一行待同步意图，每次入队都换发 seq 作为认领令牌 (见批量版)。
// 单一 worker 串行消费 + 应用器读取最新状态，从根本上消除并发写的反序覆盖：
// 无论多少次并发变更，同一 patch 最终只会被读到“当前”状态并写入。
// client 传业务写所在事务的 tx，使入队与补丁变更原子提交（C-full，关闭“提交后再
// 入队”的崩溃丢失窗口）；传顶层 prisma 则独立自动提交（queueSearchSync 兜底路径）。
export const enqueueSearchOutbox = async (
  client: KunTx,
  patchId: number,
  options?: { mode?: EnqueueMode }
) => {
  await enqueueSearchOutboxBatch(client, [patchId], options)
}

// 批量入队：标签/会社改名或删除会波及其下全部关联 patch（热门标签可达数百上千），
// 逐条 upsert 的往返次数会打满交互事务超时，故单条 SQL 完成整批。updated 是
// @updatedAt（应用层维护，原生 SQL 必须显式赋值），时间写 UTC 墙钟与 Prisma 一致。
// seq 新插入由列默认值、冲突时显式从同一个全局序列取值，永不重复：从 0 起计、冲突加 1 的话，
// 一个 drain 删掉 (P, 0) 之后重新插入的行又是 (P, 0)，并发的第二个 drain (续锁失败) 会按
// 旧读数把它删掉，那次变更就不再同步。
// mode 'write' (应用写入，默认) 复位失败记录：内容变了，被拒的那一版可能已经修好。
// 'reconcile' (对账发现漂移) 只换发 seq：处理中的 drain 不会按旧读数删掉这一行，但已退避或
// 隔离的行保持原样，确定性失败的文档不会每晚被拉回重试
export const enqueueSearchOutboxBatch = async (
  client: KunTx,
  patchIds: number[],
  { mode = 'write' }: { mode?: EnqueueMode } = {}
) => {
  if (patchIds.length === 0) {
    return
  }
  // 去重防同语句二次命中同行（21000 直接炸事务）；升序统一锁序，与并发的
  // 批量/循环入队互不死锁（项目惯例：批内加锁一律升序）
  const ids = [...new Set(patchIds)].sort((a, b) => a - b)
  if (mode === 'reconcile') {
    await client.$executeRaw`
      INSERT INTO search_outbox (patch_id, created, updated)
      SELECT unnest(${ids}::int[]),
        now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
      ON CONFLICT (patch_id) DO UPDATE
        SET seq = nextval(pg_get_serial_sequence('search_outbox', 'seq')),
          updated = now() AT TIME ZONE 'UTC'`
    return
  }
  await client.$executeRaw`
    INSERT INTO search_outbox (patch_id, created, updated)
    SELECT unnest(${ids}::int[]),
      now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
    ON CONFLICT (patch_id) DO UPDATE
      SET seq = nextval(pg_get_serial_sequence('search_outbox', 'seq')),
        updated = now() AT TIME ZONE 'UTC',
        attempts = 0,
        next_attempt_at = NULL,
        last_error = NULL`
}

interface OutboxRow {
  patch_id: number
  seq: number
  attempts: number
}

type RowOutcome = 'synced' | 'failed' | 'engine-unavailable'

const applyOutboxRow = async (row: OutboxRow): Promise<RowOutcome> => {
  try {
    await syncPatchToSearch(row.patch_id)
  } catch (error) {
    // 两种记账都按 (patch_id, seq) 条件更新：处理期间有新的入队时 seq 已变，这次失败不算在
    // 新内容头上。updateMany 会顺带刷新 @updatedAt，这一行于是排到队尾
    const cas = { patch_id: row.patch_id, seq: row.seq }
    if (isEngineWideWriteFailure(error)) {
      // 不计次数，但把这一行往后挪：引擎真的不可用时每轮只碰一行；若失败其实只属于这份文档
      // (引擎处理它时崩溃、处理它超过 30 秒)，它也不会一直顶在队头挡住后面的行
      await prisma.search_outbox.updateMany({
        where: cas,
        data: {
          next_attempt_at: new Date(Date.now() + OUTBOX_ENGINE_RETRY_DELAY_MS)
        }
      })
      // eslint-disable-next-line no-console
      console.warn(
        `[kun-search] Meilisearch 此刻收不了写入, 本轮出箱消费在 patch ${row.patch_id} 处提前结束, 不计失败次数 (总是同一个 patch 时多半是这份文档自己的问题):`,
        describeError(error)
      )
      return 'engine-unavailable'
    }
    const attempts = row.attempts + 1
    const { count } = await prisma.search_outbox.updateMany({
      where: cas,
      data: {
        attempts,
        next_attempt_at: new Date(Date.now() + backoffMs(attempts)),
        last_error: describeError(error)
      }
    })
    const accounting =
      count === 0
        ? '处理期间又有新的入队, 这次不计'
        : attempts >= SEARCH_OUTBOX_MAX_ATTEMPTS
          ? `第 ${attempts} 次, 已隔离, 应用写入再次入队或 pnpm search:reconcile --retry-failed 才会重试`
          : `第 ${attempts} 次`
    // eslint-disable-next-line no-console
    console.error(
      `[kun-search] 搜索写出箱同步 patch ${row.patch_id} 失败 (${accounting}):`,
      describeError(error)
    )
    return 'failed'
  }
  // 成功才按 (patch_id, seq) 条件删除：处理期间有并发入队使 seq 变化，则条件不命中、该行
  // 滞留等待下一轮，不丢失新变更
  await prisma.search_outbox.deleteMany({
    where: { patch_id: row.patch_id, seq: row.seq }
  })
  return 'synced'
}

export interface SearchDrainResult {
  // drained: 可取的行已取完；paused: 只跑一批或预算用完，可能还有行；engine-unavailable:
  // Meilisearch 整体收不了写入，提前结束；locked: 写锁在别的写者手里；disabled: 未配置引擎
  outcome: 'drained' | 'paused' | 'engine-unavailable' | 'locked' | 'disabled'
  synced: number
  failed: number
}

// 单一消费者：持写锁逐行读取最新状态后应用，成功才删行，被拒的行退避、到上限后隔离。
// 不传 budgetMs 只跑一批；传了就在预算内连续取批直到取完 (cron 约 50 秒，请求进程里的 kick
// 2 秒)，预算在每行之后检查。取行只取没隔离、退避已到期的，按最后一次入队或记账的先后。
// 写锁丢失或 signal 中止 (cron 进程关停) 时在下一行之前停下 (paused)：单行的写入有上界
// (lib/meilisearch.ts 的请求超时与 waitTask 的 30 秒)，停下之前至多再写完手上这一行
export const drainSearchOutbox = async ({
  budgetMs,
  signal
}: {
  budgetMs?: number
  signal?: AbortSignal
} = {}): Promise<SearchDrainResult> => {
  if (!getMeiliClient()) {
    return { outcome: 'disabled', synced: 0, failed: 0 }
  }
  const deadline = budgetMs === undefined ? null : Date.now() + budgetMs

  const result = await withSearchWriter(
    'searchOutboxDrain',
    async (writer): Promise<SearchDrainResult> => {
      let synced = 0
      let failed = 0
      for (;;) {
        const rows = await prisma.search_outbox.findMany({
          where: {
            attempts: { lt: SEARCH_OUTBOX_MAX_ATTEMPTS },
            OR: [
              { next_attempt_at: null },
              { next_attempt_at: { lte: new Date() } }
            ]
          },
          orderBy: { updated: 'asc' },
          take: OUTBOX_DRAIN_BATCH_SIZE,
          select: { patch_id: true, seq: true, attempts: true }
        })

        for (const row of rows) {
          if (writer.signal.aborted) {
            return { outcome: 'paused', synced, failed }
          }
          const outcome = await applyOutboxRow(row)
          writer.progress()
          if (outcome === 'engine-unavailable') {
            return { outcome, synced, failed }
          }
          if (outcome === 'synced') {
            synced++
          } else {
            failed++
          }
          if (deadline !== null && Date.now() >= deadline) {
            return { outcome: 'paused', synced, failed }
          }
        }

        if (rows.length < OUTBOX_DRAIN_BATCH_SIZE) {
          return { outcome: 'drained', synced, failed }
        }
        if (deadline === null) {
          return { outcome: 'paused', synced, failed }
        }
      }
    },
    { signal }
  )
  return result ?? { outcome: 'locked', synced: 0, failed: 0 }
}

// 出箱现状：可取的、在退避里的、已隔离的各有多少，以及隔离行的失败原因 (供对账命令打印)
export const getSearchOutboxBacklog = async () => {
  const now = new Date()
  const [ready, backoff, quarantined] = await Promise.all([
    prisma.search_outbox.count({
      where: {
        attempts: { lt: SEARCH_OUTBOX_MAX_ATTEMPTS },
        OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }]
      }
    }),
    prisma.search_outbox.count({
      where: {
        attempts: { lt: SEARCH_OUTBOX_MAX_ATTEMPTS },
        next_attempt_at: { gt: now }
      }
    }),
    prisma.search_outbox.findMany({
      where: { attempts: { gte: SEARCH_OUTBOX_MAX_ATTEMPTS } },
      orderBy: { patch_id: 'asc' },
      select: { patch_id: true, last_error: true }
    })
  ])
  return { ready, backoff, quarantined }
}

// 对账命令用：在本进程里连续排空出箱，直到没有可取的行。写锁在 cron 的 drain 手里时等它 (两边
// 排的是同一个出箱)；连续 stallMs 既没写入或被拒、可取的行数也没减少 (Meilisearch 收不了写入，
// 或写锁一直拿不到——多半是 Redis 不可用) 就抛错，剩下的交给 cron 进程
export const drainSearchOutboxUntilEmpty = async ({
  roundMs = 50_000,
  waitMs = 5_000,
  stallMs = 10 * 60_000,
  onRound
}: {
  roundMs?: number
  waitMs?: number
  stallMs?: number
  onRound?: (round: SearchDrainResult, ready: number) => void
} = {}) => {
  let progressAt = Date.now()
  let lastReady = Number.POSITIVE_INFINITY
  for (;;) {
    const round = await drainSearchOutbox({ budgetMs: roundMs })
    if (round.outcome === 'disabled') {
      return
    }
    if (round.outcome === 'locked' || round.outcome === 'engine-unavailable') {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
    const { ready } = await getSearchOutboxBacklog()
    onRound?.(round, ready)
    if (ready === 0) {
      return
    }
    if (
      round.synced + round.failed > 0 ||
      (round.outcome === 'locked' && ready < lastReady)
    ) {
      progressAt = Date.now()
    }
    lastReady = ready
    if (Date.now() - progressAt >= stallMs) {
      throw new Error(
        `出箱 ${Math.round(stallMs / 60_000)} 分钟没有进展 (Meilisearch 收不了写入, 或写锁一直拿不到——多半是 Redis 不可用), 剩余可取 ${ready} 条交给 cron 进程排空`
      )
    }
  }
}

// 即时消费：入队后立刻尝试 drain 一次，保持近实时同步；抢不到锁则由定时任务兜底。
const kickDrain = () => {
  void drainSearchOutbox({ budgetMs: KICK_DRAIN_BUDGET_MS }).catch((error) => {
    // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
      console.error(`patch ${patchId} 入搜索写出箱失败:`, error)
    })
}

export const queueSearchSync = queueSearchOutbox
export const queueSearchRemove = queueSearchOutbox
