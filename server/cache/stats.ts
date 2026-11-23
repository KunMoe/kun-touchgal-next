// 读缓存的去留度量: 按命名空间累计每次读取的结果与耗时, 每个进程每 5 分钟往 stdout
// 写一行 JSON (ev=kun.cache.stats) 后清零, 由 pnpm cache:stats (scripts/cache/stats.ts) 汇总。
// 只记在进程内存, 不碰 Redis, 记录本身不会失败。某个缓存留不留, 看它直读一个观察周期比命中时
// 慢多少 (判据见 scripts/cache/lib/summary.ts 的 evaluateG1), 不看失效点有多少

export type KunCacheNamespace =
  | 'patch:page'
  | 'patch:favorite'
  | 'resource:list'
  | 'resource:list:stats'
  | 'message:unread'

// hit: 首次读即命中; miss: 本请求回源 (含单飞等待超时后自己回源);
// wait: 本请求没有回源, 结果来自别人写进缓存的那一份; degraded: 缓存读失败后直连数据库;
// notFound: 回源查无此行 (不写缓存); direct: 按设计或开关没有读缓存, 直接查库
export type KunCacheOutcome =
  'hit' | 'miss' | 'wait' | 'degraded' | 'notFound' | 'direct'

// 桶上界 (毫秒, 含上界), 之后还有一个 +∞ 桶。改分桶时汇总脚本照每行自带的 le 读, 不用跟着改
const BUCKETS_MS = [1, 2, 3, 5, 8, 13, 20, 35, 50, 100, 250, 500]
const FLUSH_INTERVAL_MS = 5 * 60 * 1000

interface OutcomeStats {
  n: number
  // 整次读取的耗时
  total: number[]
  // 其中回源 (查库与组装) 的耗时, 只有回源过的结果才有
  source?: number[]
}

const windows = new Map<KunCacheNamespace, Map<KunCacheOutcome, OutcomeStats>>()
let windowStartedAt = 0
let flushTimer: ReturnType<typeof setInterval> | null = null

const emptyBuckets = () => new Array<number>(BUCKETS_MS.length + 1).fill(0)

const addToBuckets = (buckets: number[], ms: number) => {
  const index = BUCKETS_MS.findIndex((le) => ms <= le)
  buckets[index === -1 ? BUCKETS_MS.length : index] += 1
}

const flushKunCacheStats = () => {
  const now = Date.now()
  for (const [ns, outcomes] of windows) {
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({
        ev: 'kun.cache.stats',
        ns,
        pid: process.pid,
        t: new Date(now).toISOString(),
        sec: Math.round((now - windowStartedAt) / 1000),
        le: BUCKETS_MS,
        outcomes: Object.fromEntries(outcomes)
      })
    )
  }
  windows.clear()
  windowStartedAt = now
}

export const kunRecordCacheOutcome = (
  ns: KunCacheNamespace,
  outcome: KunCacheOutcome,
  totalMs: number,
  sourceMs?: number
) => {
  if (!flushTimer) {
    windowStartedAt = Date.now()
    flushTimer = setInterval(flushKunCacheStats, FLUSH_INTERVAL_MS)
    // 只为度量存在的定时器不应拖住进程退出
    flushTimer.unref()
  }

  let outcomes = windows.get(ns)
  if (!outcomes) {
    outcomes = new Map()
    windows.set(ns, outcomes)
  }
  let stats = outcomes.get(outcome)
  if (!stats) {
    stats = { n: 0, total: emptyBuckets() }
    outcomes.set(outcome, stats)
  }

  stats.n += 1
  addToBuckets(stats.total, totalMs)
  if (sourceMs !== undefined) {
    stats.source ??= emptyBuckets()
    addToBuckets(stats.source, sourceMs)
  }
}
