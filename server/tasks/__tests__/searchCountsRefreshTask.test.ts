import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GalgameSearchCountsDoc } from '~/server/search/document'

const {
  patchFindManyMock,
  applyCountsMock,
  withSearchWriterMock,
  getMeiliClientMock,
  getKvHashAllMock,
  setKvHashFieldsMock
} = vi.hoisted(() => ({
  patchFindManyMock: vi.fn(),
  applyCountsMock: vi.fn(),
  withSearchWriterMock: vi.fn(),
  getMeiliClientMock: vi.fn(),
  getKvHashAllMock: vi.fn(),
  setKvHashFieldsMock: vi.fn()
}))

vi.mock('~/prisma', () => ({
  prisma: { patch: { findMany: patchFindManyMock } }
}))

vi.mock('~/lib/meilisearch', () => ({
  getMeiliClient: getMeiliClientMock
}))

vi.mock('~/lib/redis', () => ({
  getKvHashAll: getKvHashAllMock,
  setKvHashFields: setKvHashFieldsMock
}))

// 写锁与 applyCounts 的行为 (剔除出箱里挂着行的 id、等任务终态) 在 sync.test.ts 里测
vi.mock('~/server/search/sync', () => ({
  withSearchWriter: withSearchWriterMock
}))

import {
  refreshSearchCounts,
  countsFingerprint,
  searchCountsRefreshJob
} from '~/server/tasks/searchCountsRefreshTask'

// 写锁的 signal: 用例中止它模拟租约丢失或关停
let writerSignal: AbortController
const progressMock = vi.fn()
const writer = {
  get signal() {
    return writerSignal.signal
  },
  progress: progressMock,
  applyCounts: applyCountsMock
}

interface PatchCountsRow {
  id: number
  view: number
  download: number
  favorite_count: number
  resource_count: number
  comment_count: number
  rating_stat: { avg_overall: number; count: number } | null
}

const makeRow = (
  id: number,
  overrides: Partial<PatchCountsRow> = {}
): PatchCountsRow => ({
  id,
  view: 10,
  download: 5,
  favorite_count: 2,
  resource_count: 1,
  comment_count: 3,
  rating_stat: { avg_overall: 8, count: 4 },
  ...overrides
})

const docOf = (row: PatchCountsRow): GalgameSearchCountsDoc => ({
  id: row.id,
  view: row.view,
  download: row.download,
  favoriteCount: row.favorite_count,
  resourceCount: row.resource_count,
  commentCount: row.comment_count,
  ratingCount: row.rating_stat?.count ?? 0,
  avgRating: row.rating_stat?.avg_overall ?? 0
})

const fpOf = (row: PatchCountsRow) => countsFingerprint(docOf(row))

// findMany 是游标分页：先返回给定批次，再返回空数组终止循环
const mockRowsOnce = (rows: PatchCountsRow[]) => {
  patchFindManyMock.mockResolvedValueOnce(rows).mockResolvedValueOnce([])
}

const pushedDocs = (call: number): GalgameSearchCountsDoc[] =>
  applyCountsMock.mock.calls[call][0]

beforeEach(() => {
  patchFindManyMock.mockReset()
  // 默认全部写入: 原样返回传入的文档
  applyCountsMock
    .mockReset()
    .mockImplementation(async (docs: GalgameSearchCountsDoc[]) => docs)
  writerSignal = new AbortController()
  withSearchWriterMock
    .mockReset()
    .mockImplementation(
      (_name: string, fn: (w: typeof writer) => Promise<unknown>) => fn(writer)
    )
  getKvHashAllMock.mockReset().mockResolvedValue({})
  setKvHashFieldsMock.mockReset().mockResolvedValue(undefined)
  getMeiliClientMock.mockReset().mockReturnValue({})
})

describe('searchCountsRefreshJob 与出箱共用写锁', () => {
  let stop: AbortController
  beforeEach(() => {
    stop = new AbortController()
  })
  const runTask = () =>
    searchCountsRefreshJob.run({
      signal: stop.signal,
      cancelSignal: new AbortController().signal,
      progress: () => {}
    })

  it('未配置 Meili 时直接返回，不抢锁、不读库', async () => {
    getMeiliClientMock.mockReturnValue(null)

    await runTask()

    expect(withSearchWriterMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).not.toHaveBeenCalled()
  })

  it('经写锁运行, 锁被占着时等 drain 放锁 (两者在同一秒触发)', async () => {
    mockRowsOnce([makeRow(1)])

    await runTask()

    expect(withSearchWriterMock).toHaveBeenCalledWith(
      'searchCountsRefreshTask',
      expect.any(Function),
      { waitMs: 90_000, signal: expect.any(AbortSignal) }
    )
    expect(applyCountsMock).toHaveBeenCalledTimes(1)
  })

  // 关停时不再等锁: 那不是「90 秒内没等到」
  it('关停中返回而没拿到锁: 不记跳过的日志', async () => {
    withSearchWriterMock.mockResolvedValue(undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stop.abort()

    await runTask()

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('等不到锁时本轮跳过、不读库, 并留一条日志', async () => {
    withSearchWriterMock.mockResolvedValue(undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runTask()

    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('搜索计数快照刷新跳过')
    )
    warnSpy.mockRestore()
  })

  // 出错交给作业层按作业名记录 (server/jobs/registry.ts)
  it('刷新出错原样抛给作业层, 不当成没等到锁', async () => {
    withSearchWriterMock.mockRejectedValue(new Error('boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(runTask()).rejects.toThrow('boom')

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('refreshSearchCounts 快照 diff', () => {
  it('快照为空（冷启动）时推送全部行并写回其指纹', async () => {
    getKvHashAllMock.mockResolvedValue({})
    mockRowsOnce([makeRow(1), makeRow(2)])

    await refreshSearchCounts(writer)

    expect(applyCountsMock).toHaveBeenCalledTimes(1)
    expect(pushedDocs(0).map((d) => d.id)).toEqual([1, 2])
    expect(setKvHashFieldsMock).toHaveBeenCalledWith('search:counts:fp', {
      '1': fpOf(makeRow(1)),
      '2': fpOf(makeRow(2))
    })
  })

  it('仅推送指纹相较快照发生变化的行，未变行不进 payload', async () => {
    const unchanged = makeRow(1)
    const changed = makeRow(2, { view: 999 })
    // 快照中 id=1 与当前一致（未变），id=2 为旧值（已变）
    getKvHashAllMock.mockResolvedValue({
      '1': fpOf(unchanged),
      '2': fpOf(makeRow(2, { view: 1 }))
    })
    mockRowsOnce([unchanged, changed])

    await refreshSearchCounts(writer)

    expect(applyCountsMock).toHaveBeenCalledTimes(1)
    expect(pushedDocs(0).map((d) => d.id)).toEqual([2])
    expect(setKvHashFieldsMock).toHaveBeenCalledWith('search:counts:fp', {
      '2': fpOf(changed)
    })
  })

  it('整批零变更时没有要写的文档，也不写快照', async () => {
    const r1 = makeRow(1)
    const r2 = makeRow(2)
    getKvHashAllMock.mockResolvedValue({ '1': fpOf(r1), '2': fpOf(r2) })
    mockRowsOnce([r1, r2])

    await refreshSearchCounts(writer)

    expect(pushedDocs(0)).toEqual([])
    expect(setKvHashFieldsMock).not.toHaveBeenCalled()
  })

  it('出箱里挂着行而被剔除的 id 不写快照，下一轮照旧比对', async () => {
    mockRowsOnce([makeRow(1), makeRow(2)])
    applyCountsMock.mockImplementation(async (docs: GalgameSearchCountsDoc[]) =>
      docs.filter((doc) => doc.id !== 2)
    )

    await refreshSearchCounts(writer)

    expect(setKvHashFieldsMock).toHaveBeenCalledWith('search:counts:fp', {
      '1': fpOf(makeRow(1))
    })
  })

  it('Meili 批次失败时抛错且不写回快照（保留下轮重推）', async () => {
    applyCountsMock.mockRejectedValue(new Error('计数快照批次写入失败'))
    mockRowsOnce([makeRow(1)])

    await expect(refreshSearchCounts(writer)).rejects.toThrow(
      '计数快照批次写入失败'
    )
    expect(setKvHashFieldsMock).not.toHaveBeenCalled()
  })

  it('指纹串与改造前逐个手写的格式相同，Redis 里已有的快照照常可用', () => {
    expect(countsFingerprint(docOf(makeRow(1)))).toBe('10|5|2|1|3|4|8')
  })

  it('指纹覆盖 avgRating/ratingCount 等全部计数字段', async () => {
    const base = makeRow(1)
    const ratingChanged = makeRow(1, {
      rating_stat: { avg_overall: 9, count: 4 }
    })

    expect(fpOf(ratingChanged)).not.toBe(fpOf(base))
  })

  it('跨批处理：逐批 diff、游标随批推进（含未变行）、每批独立推送与写快照', async () => {
    const r1 = makeRow(1, { view: 111 }) // 变
    const r2 = makeRow(2) // 未变（快照命中）
    const r3 = makeRow(3, { download: 77 }) // 变
    getKvHashAllMock.mockResolvedValue({ '2': fpOf(r2) })
    patchFindManyMock
      .mockResolvedValueOnce([r1, r2])
      .mockResolvedValueOnce([r3])
      .mockResolvedValueOnce([])

    await refreshSearchCounts(writer)

    // 每批各推一次，r2 未变被剔除; 每做完一批报一次进度 (写锁的停滞看门狗)
    expect(applyCountsMock).toHaveBeenCalledTimes(2)
    expect(progressMock).toHaveBeenCalledTimes(2)
    expect(pushedDocs(0).map((d) => d.id)).toEqual([1])
    expect(pushedDocs(1).map((d) => d.id)).toEqual([3])
    // 游标随批推进：即便 r2 未变，lastId 也推进到 2，第三批查 id>3
    expect(patchFindManyMock.mock.calls[1][0].where).toEqual({ id: { gt: 2 } })
    expect(patchFindManyMock.mock.calls[2][0].where).toEqual({ id: { gt: 3 } })
    // 每批独立写回各自变更指纹
    expect(setKvHashFieldsMock).toHaveBeenNthCalledWith(1, 'search:counts:fp', {
      '1': fpOf(r1)
    })
    expect(setKvHashFieldsMock).toHaveBeenNthCalledWith(2, 'search:counts:fp', {
      '3': fpOf(r3)
    })
  })

  it('写锁丢失或关停 (writer.signal 中止) 时停在两批之间, 抛出中止原因', async () => {
    const reason = new Error('lease lost')
    patchFindManyMock
      .mockResolvedValueOnce([makeRow(1)])
      .mockResolvedValueOnce([makeRow(2)])
    applyCountsMock.mockImplementationOnce(
      async (docs: GalgameSearchCountsDoc[]) => {
        writerSignal.abort(reason)
        return docs
      }
    )

    await expect(refreshSearchCounts(writer)).rejects.toBe(reason)

    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    // 已写入的那一批照常写回快照
    expect(setKvHashFieldsMock).toHaveBeenCalledOnce()
  })
})
