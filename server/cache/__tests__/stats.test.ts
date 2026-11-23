import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FIVE_MINUTES = 5 * 60 * 1000

// 模块状态 (窗口与定时器) 每个用例重新导入一份
const loadStats = () => import('~/server/cache/stats')

const printedLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => JSON.parse(String(call[0])))

describe('kunRecordCacheOutcome', () => {
  let info: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-24T00:00:00.000Z'))
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })

  afterEach(() => {
    info.mockRestore()
    vi.useRealTimers()
  })

  it('每 5 分钟每个有记录的命名空间输出一行, 输出后清零', async () => {
    const { kunRecordCacheOutcome } = await loadStats()
    kunRecordCacheOutcome('patch:page', 'hit', 0.4)
    kunRecordCacheOutcome('patch:page', 'hit', 2.5)
    kunRecordCacheOutcome('patch:page', 'miss', 9, 7)
    kunRecordCacheOutcome('message:unread', 'degraded', 600, 4)

    vi.advanceTimersByTime(FIVE_MINUTES - 1)
    expect(info).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    const lines = printedLines(info)
    expect(lines).toHaveLength(2)
    const zeros = () => new Array(13).fill(0)
    const bucketsWith = (entries: Record<number, number>) => {
      const buckets = zeros()
      for (const [index, count] of Object.entries(entries)) {
        buckets[Number(index)] = count
      }
      return buckets
    }
    expect(lines[0]).toEqual({
      ev: 'kun.cache.stats',
      ns: 'patch:page',
      pid: process.pid,
      t: '2026-11-24T00:05:00.000Z',
      sec: 300,
      le: [1, 2, 3, 5, 8, 13, 20, 35, 50, 100, 250, 500],
      outcomes: {
        // 0.4 → ≤1 桶, 2.5 → ≤3 桶
        hit: { n: 2, total: bucketsWith({ 0: 1, 2: 1 }) },
        // 9 → ≤13 桶, 回源 7 → ≤8 桶
        miss: {
          n: 1,
          total: bucketsWith({ 5: 1 }),
          source: bucketsWith({ 4: 1 })
        }
      }
    })
    // 超过最后一个上界的落进 +∞ 桶
    expect(lines[1]).toMatchObject({
      ns: 'message:unread',
      outcomes: {
        degraded: { n: 1, total: bucketsWith({ 12: 1 }) }
      }
    })

    vi.advanceTimersByTime(FIVE_MINUTES)
    expect(info).toHaveBeenCalledTimes(2)
  })

  it('桶上界含等号: 恰好等于上界的值记在该桶', async () => {
    const { kunRecordCacheOutcome } = await loadStats()
    for (const ms of [1, 1.0001, 20, 20.0001, 500, 500.0001]) {
      kunRecordCacheOutcome('resource:list', 'direct', ms)
    }

    vi.advanceTimersByTime(FIVE_MINUTES)

    const [line] = printedLines(info)
    const total = line.outcomes.direct.total as number[]
    expect(total[0]).toBe(1)
    expect(total[1]).toBe(1)
    expect(total[6]).toBe(1)
    expect(total[7]).toBe(1)
    expect(total[11]).toBe(1)
    expect(total[12]).toBe(1)
    expect(line.outcomes.direct).not.toHaveProperty('source')
  })

  it('定时器在第一次记录时才启动, 且不拖住进程退出', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      const { kunRecordCacheOutcome } = await loadStats()
      expect(setIntervalSpy).not.toHaveBeenCalled()

      kunRecordCacheOutcome('patch:favorite', 'hit', 1)
      kunRecordCacheOutcome('patch:favorite', 'miss', 2, 1)

      expect(setIntervalSpy).toHaveBeenCalledTimes(1)
      const timer = setIntervalSpy.mock.results[0].value as NodeJS.Timeout
      expect(timer.hasRef()).toBe(false)
    } finally {
      setIntervalSpy.mockRestore()
    }
  })
})
