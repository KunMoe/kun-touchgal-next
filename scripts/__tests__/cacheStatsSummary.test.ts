import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addCacheStatsLine,
  evaluateG1,
  parseCacheStatsLine,
  quantileBucket,
  shareWithin
} from '~/scripts/cache/lib/summary'
import type {
  KunCacheStatsLine,
  NamespaceSummary
} from '~/scripts/cache/lib/summary'

const LE = [1, 2, 3, 5, 8, 13, 20, 35, 50, 100, 250, 500]

// 按桶下标给出计数, 其余为 0
const buckets = (entries: Record<number, number>) => {
  const counts = new Array(LE.length + 1).fill(0)
  for (const [index, count] of Object.entries(entries)) {
    counts[Number(index)] = count
  }
  return counts
}

const line = (
  overrides: Partial<KunCacheStatsLine> = {}
): KunCacheStatsLine => ({
  ns: 'patch:page',
  pid: 1,
  t: '2026-11-25T00:05:00.000Z',
  le: LE,
  outcomes: {},
  ...overrides
})

const summarize = (lines: KunCacheStatsLine[]) => {
  const summaries = new Map<string, NamespaceSummary>()
  for (const item of lines) {
    addCacheStatsLine(summaries, item)
  }
  return summaries
}

describe('parseCacheStatsLine', () => {
  it('从第一个 { 开始解析, 只认 kun.cache.stats', () => {
    const json = JSON.stringify({ ev: 'kun.cache.stats', ns: 'patch:page' })
    expect(parseCacheStatsLine(`0|kun-touchgal-next | ${json}`)).toMatchObject({
      ns: 'patch:page'
    })
    expect(parseCacheStatsLine('{"ev":"other"}')).toBeNull()
    expect(parseCacheStatsLine('[kunTx:afterCommit] {broken')).toBeNull()
    expect(parseCacheStatsLine('plain text')).toBeNull()
  })
})

describe('addCacheStatsLine', () => {
  it('跨进程跨行逐桶相加, 记下时间范围与进程数', () => {
    const summaries = summarize([
      line({
        pid: 1,
        t: '2026-11-25T00:10:00.000Z',
        outcomes: { hit: { n: 2, total: buckets({ 0: 2 }) } }
      }),
      line({
        pid: 2,
        t: '2026-11-25T00:05:00.000Z',
        outcomes: {
          hit: { n: 1, total: buckets({ 2: 1 }) },
          miss: { n: 1, total: buckets({ 5: 1 }), source: buckets({ 4: 1 }) }
        }
      }),
      // 分桶不同的行不能相加
      line({ le: [10, 100], outcomes: { hit: { n: 9, total: [9, 0, 0] } } })
    ])

    const summary = summaries.get('patch:page')!
    expect(summary.lines).toBe(2)
    expect(summary.skipped).toBe(1)
    expect(summary.pids.size).toBe(2)
    expect(summary.from).toBe('2026-11-25T00:05:00.000Z')
    expect(summary.to).toBe('2026-11-25T00:10:00.000Z')
    expect(summary.outcomes.get('hit')).toEqual({
      n: 3,
      total: buckets({ 0: 2, 2: 1 }),
      source: buckets({})
    })
    expect(summary.outcomes.get('miss')?.source).toEqual(buckets({ 4: 1 }))
  })
})

describe('quantileBucket / shareWithin', () => {
  it('返回分位数所在桶的上界, 最后一个桶为 Infinity', () => {
    const counts = buckets({ 0: 50, 4: 49, 12: 1 })
    expect(quantileBucket(counts, LE, 0.5)).toBe(1)
    expect(quantileBucket(counts, LE, 0.51)).toBe(8)
    expect(quantileBucket(counts, LE, 0.99)).toBe(8)
    expect(quantileBucket(counts, LE, 1)).toBe(Infinity)
    expect(quantileBucket(buckets({}), LE, 0.5)).toBeNull()
  })

  it('按桶上界统计不超过阈值的比例, +∞ 桶不算在内', () => {
    expect(shareWithin(buckets({ 6: 99, 12: 1 }), LE, 20)).toBe(0.99)
    expect(shareWithin(buckets({ 7: 1, 12: 1 }), LE, 20)).toBe(0)
    expect(shareWithin(buckets({}), LE, 20)).toBeNull()
  })
})

describe('evaluateG1', () => {
  const g1 = (direct: Record<number, number>, hit: Record<number, number>) =>
    evaluateG1(
      summarize([
        line({
          outcomes: {
            hit: { n: 1, total: buckets(hit) },
            direct: { n: 1, total: buckets(direct) }
          }
        })
      ]).get('patch:page')!
    )

  it('99% 在 20ms 以内且中位桶差 5ms 时通过 (边界含等号)', () => {
    // direct 中位 ≤8, hit 中位 ≤3
    expect(g1({ 4: 99, 7: 1 }, { 2: 1 })).toMatchObject({
      within20: 0.99,
      directMedian: 8,
      hitMedian: 3,
      pass: true
    })
  })

  it('20ms 以内不足 99% 或中位桶差超过 5ms 时不通过', () => {
    expect(g1({ 4: 98, 7: 2 }, { 2: 1 })?.pass).toBe(false)
    // direct 中位 ≤13, hit 中位 ≤3, 差 10
    expect(g1({ 5: 100 }, { 2: 1 })?.pass).toBe(false)
  })

  it('缺 hit 或 direct 时不评估', () => {
    const summary = summarize([
      line({ outcomes: { hit: { n: 1, total: buckets({ 0: 1 }) } } })
    ]).get('patch:page')!
    expect(evaluateG1(summary)).toBeNull()
  })
})

describe('与 server/cache/stats.ts 的输出对得上', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('度量模块写出的行能被解析并原样相加', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { kunRecordCacheOutcome } = await import('~/server/cache/stats')

    kunRecordCacheOutcome('resource:list:stats', 'hit', 2)
    kunRecordCacheOutcome('resource:list:stats', 'direct', 15, 14)
    vi.advanceTimersByTime(5 * 60 * 1000)

    const parsed = parseCacheStatsLine(String(info.mock.calls[0][0]))!
    const summary = summarize([parsed]).get('resource:list:stats')!
    expect(summary.le).toEqual(LE)
    expect(summary.outcomes.get('hit')?.total).toEqual(buckets({ 1: 1 }))
    expect(summary.outcomes.get('direct')).toEqual({
      n: 1,
      total: buckets({ 6: 1 }),
      source: buckets({ 6: 1 })
    })
  })
})
