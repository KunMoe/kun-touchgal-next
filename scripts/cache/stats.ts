/* eslint-disable no-console */
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { parseArgs } from 'util'
import { createGunzip } from 'zlib'
import {
  OUTCOME_ORDER,
  addCacheStatsLine,
  evaluateG1,
  parseCacheStatsLine,
  quantileBucket,
  shareWithin
} from './lib/summary'
import type { NamespaceSummary } from './lib/summary'

// 汇总读缓存的度量行 (server/cache/stats.ts, 每个进程每 5 分钟一行)。只读, 不连库与 Redis:
//   pnpm cache:stats ~/.pm2/logs/kun-touchgal-next-out*.log
//   pnpm cache:stats --since 2026-11-25T00:00:00Z --until 2026-12-02T00:00:00Z <日志...>
// 不给文件时读标准输入 (.gz 的轮转日志可以直接给, 也可以 zcat 后管道进来)

const formatMs = (ms: number | null) =>
  ms === null ? '-' : ms === Infinity ? '>500' : `≤${ms}`

const formatShare = (share: number | null) =>
  share === null ? '-' : `${(share * 100).toFixed(1)}%`

// 按终端显示宽度补齐 (汉字占两列)
const formatRow = (cells: string[]) =>
  cells
    .map((cell) => {
      const width = [...cell].reduce(
        (acc, char) => acc + (char.charCodeAt(0) >= 0x2e80 ? 2 : 1),
        0
      )
      return cell + ' '.repeat(Math.max(1, 10 - width))
    })
    .join('')

const printSummary = (ns: string, summary: NamespaceSummary) => {
  const all = [...summary.outcomes.values()].reduce((acc, o) => acc + o.n, 0)
  const cacheable = all - (summary.outcomes.get('direct')?.n ?? 0)
  console.log(
    `\n${ns}  ${summary.lines} 行 · ${summary.pids.size} 个进程 · ${summary.from} ~ ${summary.to}` +
      (summary.skipped ? ` · 分桶不一致跳过 ${summary.skipped} 行` : '')
  )
  console.log(
    formatRow([
      '结果',
      '次数',
      '占比',
      '中位',
      'p99',
      '≤20ms',
      '回源中位',
      '回源p99'
    ])
  )
  const outcomes = [...summary.outcomes.keys()].sort(
    (a, b) => OUTCOME_ORDER.indexOf(a) - OUTCOME_ORDER.indexOf(b)
  )
  for (const outcome of outcomes) {
    const { n, total, source } = summary.outcomes.get(outcome)!
    console.log(
      formatRow([
        outcome,
        String(n),
        formatShare(n / all),
        formatMs(quantileBucket(total, summary.le, 0.5)),
        formatMs(quantileBucket(total, summary.le, 0.99)),
        formatShare(shareWithin(total, summary.le, 20)),
        formatMs(quantileBucket(source, summary.le, 0.5)),
        formatMs(quantileBucket(source, summary.le, 0.99))
      ])
    )
  }
  if (cacheable > 0) {
    const hits = summary.outcomes.get('hit')?.n ?? 0
    console.log(
      `命中率 ${formatShare(hits / cacheable)} (hit ÷ direct 以外的全部)`
    )
  }
  const g1 = evaluateG1(summary)
  if (g1) {
    console.log(
      `G1: direct ≤20ms 占 ${formatShare(g1.within20)} (要求 ≥ 99%); 中位 direct ${formatMs(g1.directMedian)} 对 hit ${formatMs(g1.hitMedian)}, 差 ${g1.directMedian - g1.hitMedian}ms (要求 ≤ 5ms) → ${g1.pass ? '通过' : '不通过'}`
    )
  }
}

const run = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      until: { type: 'string' }
    }
  })
  const since = values.since ? Date.parse(values.since) : -Infinity
  const until = values.until ? Date.parse(values.until) : Infinity
  if (Number.isNaN(since) || Number.isNaN(until)) {
    throw new Error(
      '--since / --until 要写成 ISO 时间, 例如 2026-11-25T00:00:00Z'
    )
  }

  const summaries = new Map<string, NamespaceSummary>()
  const inputs = positionals.length
    ? positionals.map((file) =>
        file.endsWith('.gz')
          ? createReadStream(file).pipe(createGunzip())
          : createReadStream(file)
      )
    : [process.stdin]
  for (const input of inputs) {
    for await (const text of createInterface({ input, crlfDelay: Infinity })) {
      const line = parseCacheStatsLine(text)
      const at = line ? Date.parse(line.t) : NaN
      if (line && at >= since && at < until) {
        addCacheStatsLine(summaries, line)
      }
    }
  }

  if (!summaries.size) {
    console.log('没有找到 kun.cache.stats 行 (看一下日志路径与时间范围)')
    return
  }
  for (const [ns, summary] of [...summaries].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    printSummary(ns, summary)
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
