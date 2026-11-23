// 汇总 server/cache/stats.ts 每 5 分钟输出的 kun.cache.stats 行 (纯函数, 不读文件)。
// 分桶照每行自带的 le 读; 同一命名空间里分桶不一致的行跳过并计数

interface OutcomeLine {
  n: number
  total: number[]
  source?: number[]
}

export interface KunCacheStatsLine {
  ns: string
  pid: number
  t: string
  le: number[]
  outcomes: Record<string, OutcomeLine>
}

export interface OutcomeSummary {
  n: number
  total: number[]
  source: number[]
}

export interface NamespaceSummary {
  le: number[]
  lines: number
  skipped: number
  pids: Set<number>
  from: string
  to: string
  outcomes: Map<string, OutcomeSummary>
}

export const OUTCOME_ORDER = [
  'hit',
  'wait',
  'miss',
  'degraded',
  'notFound',
  'direct'
]

// 日志行前面可能带 pm2 的前缀, 从第一个 { 开始解析
export const parseCacheStatsLine = (line: string): KunCacheStatsLine | null => {
  const start = line.indexOf('{')
  if (start === -1) {
    return null
  }
  try {
    const value = JSON.parse(line.slice(start))
    return value?.ev === 'kun.cache.stats' ? value : null
  } catch {
    return null
  }
}

const addInto = (target: number[], source: number[]) => {
  source.forEach((count, index) => {
    target[index] += count
  })
}

const sameBuckets = (a: number[], b: number[]) =>
  a.length === b.length && a.every((value, index) => value === b[index])

export const addCacheStatsLine = (
  summaries: Map<string, NamespaceSummary>,
  line: KunCacheStatsLine
) => {
  let summary = summaries.get(line.ns)
  if (!summary) {
    summary = {
      le: line.le,
      lines: 0,
      skipped: 0,
      pids: new Set(),
      from: line.t,
      to: line.t,
      outcomes: new Map()
    }
    summaries.set(line.ns, summary)
  }
  if (!sameBuckets(summary.le, line.le)) {
    summary.skipped += 1
    return
  }

  summary.lines += 1
  summary.pids.add(line.pid)
  if (line.t < summary.from) {
    summary.from = line.t
  }
  if (line.t > summary.to) {
    summary.to = line.t
  }

  const width = line.le.length + 1
  for (const [outcome, stats] of Object.entries(line.outcomes)) {
    let target = summary.outcomes.get(outcome)
    if (!target) {
      target = {
        n: 0,
        total: new Array(width).fill(0),
        source: new Array(width).fill(0)
      }
      summary.outcomes.set(outcome, target)
    }
    target.n += stats.n
    addInto(target.total, stats.total)
    if (stats.source) {
      addInto(target.source, stats.source)
    }
  }
}

const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0)

// 落在第几个桶里就返回那个桶的上界 (最后一个桶为 Infinity); 没有样本返回 null
export const quantileBucket = (
  counts: number[],
  le: number[],
  q: number
): number | null => {
  const n = sum(counts)
  if (!n) {
    return null
  }
  let acc = 0
  for (let index = 0; index < counts.length; index++) {
    acc += counts[index]
    if (acc >= q * n) {
      return index < le.length ? le[index] : Infinity
    }
  }
  return Infinity
}

// 上界不超过 ms 的那些桶占全部样本的比例
export const shareWithin = (counts: number[], le: number[], ms: number) => {
  const n = sum(counts)
  if (!n) {
    return null
  }
  const within = counts.reduce(
    (acc, count, index) =>
      index < le.length && le[index] <= ms ? acc + count : acc,
    0
  )
  return within / n
}

// G1: direct 至少 99% 落在 20ms 以内的桶, 且中位桶比 hit 的中位桶高出不超过 5ms
export const evaluateG1 = (summary: NamespaceSummary) => {
  const hit = summary.outcomes.get('hit')
  const direct = summary.outcomes.get('direct')
  if (!hit?.n || !direct?.n) {
    return null
  }
  const within20 = shareWithin(direct.total, summary.le, 20)!
  const hitMedian = quantileBucket(hit.total, summary.le, 0.5)!
  const directMedian = quantileBucket(direct.total, summary.le, 0.5)!
  return {
    within20,
    hitMedian,
    directMedian,
    pass: within20 >= 0.99 && directMedian - hitMedian <= 5
  }
}
