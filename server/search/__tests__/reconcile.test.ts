import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  patchToSearchDoc,
  type PatchSearchPayload
} from '~/server/search/document'

const {
  patchFindManyMock,
  getMeiliClientMock,
  getDocumentsMock,
  writeApiMock,
  enqueueBatchMock
} = vi.hoisted(() => ({
  patchFindManyMock: vi.fn(),
  getMeiliClientMock: vi.fn(),
  getDocumentsMock: vi.fn(),
  writeApiMock: vi.fn(),
  enqueueBatchMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findMany: patchFindManyMock } }
}))

vi.mock('~/lib/meilisearch', () => ({
  getMeiliClient: getMeiliClientMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutboxBatch: enqueueBatchMock
}))

// 真实的构建器; 名字叫 boom 的 patch 构建时抛错 (例如简介嵌套过深撑爆调用栈)
vi.mock('~/server/search/document', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/server/search/document')>()
  return {
    ...real,
    patchToSearchDoc: (patch: PatchSearchPayload) =>
      patch.name === 'boom'
        ? Promise.reject(new RangeError('Maximum call stack size exceeded'))
        : real.patchToSearchDoc(patch)
  }
})

import {
  detectSearchDrift,
  reconcileSearchIndex
} from '~/server/search/reconcile'

// 文档用真实的构建器, 摘要也是真算的: 判定「过时」的依据正是它
const payload = (
  id: number,
  overrides: Partial<PatchSearchPayload> = {}
): PatchSearchPayload => ({
  id,
  unique_id: `u${id}`,
  name: `游戏 ${id}`,
  banner: '',
  vndb_id: null,
  vndb_relation_id: null,
  dlsite_code: null,
  introduction: '简介',
  released: '2020-01-01',
  released_sort: 20200101,
  content_limit: 'sfw',
  type: ['pc'],
  language: ['ja'],
  platform: ['windows'],
  view: 1,
  download: 1,
  favorite_count: 0,
  resource_count: 0,
  comment_count: 0,
  created: new Date('2024-01-01T00:00:00Z'),
  resource_update_time: new Date('2024-01-01T00:00:00Z'),
  alias: [],
  tag: [{ tag: { id: 1, name: '恋爱' } }],
  company: [],
  rating_stat: null,
  ...overrides
})

const hashOf = async (row: PatchSearchPayload) =>
  (await patchToSearchDoc(row)).docHash

// PG 侧 keyset 分批: 先返回给定各批, 再返回空数组终止
const pgBatches = (...batches: PatchSearchPayload[][]) => {
  for (const batch of batches) {
    patchFindManyMock.mockResolvedValueOnce(batch)
  }
  patchFindManyMock.mockResolvedValueOnce([])
}

const indexHas = (docs: { id: number; docHash?: string }[]) => {
  getDocumentsMock.mockResolvedValue({ results: docs, total: docs.length })
}

beforeEach(() => {
  patchFindManyMock.mockReset()
  getDocumentsMock.mockReset()
  writeApiMock.mockReset()
  enqueueBatchMock.mockReset().mockResolvedValue(undefined)
  // 写 API 一律指向同一个 spy: 检测器调用了其中任何一个都会被看见
  getMeiliClientMock.mockReset().mockReturnValue({
    index: () => ({
      getDocuments: getDocumentsMock,
      addDocuments: writeApiMock,
      updateDocuments: writeApiMock,
      deleteDocument: writeApiMock,
      deleteDocuments: writeApiMock,
      deleteAllDocuments: writeApiMock
    })
  })
})

describe('detectSearchDrift 只读检测', () => {
  it('跨批读 PG 并按 keyset 推进, 只取 id 与摘要两个字段读索引', async () => {
    const rows = [payload(1), payload(2), payload(3)]
    indexHas(
      await Promise.all(
        rows.map(async (row) => ({ id: row.id, docHash: await hashOf(row) }))
      )
    )
    pgBatches(rows.slice(0, 2), rows.slice(2))

    const drift = await detectSearchDrift()

    // total=3 证明后批也并入了: 漏读后批时 id=3 会被当成索引多余项
    expect(drift).toEqual({ total: 3, missing: [], extra: [], stale: [] })
    expect(patchFindManyMock.mock.calls.map(([args]) => args.where)).toEqual([
      { id: { gt: 0 } },
      { id: { gt: 2 } },
      { id: { gt: 3 } }
    ])
    expect(patchFindManyMock.mock.calls[0][0].orderBy).toEqual({ id: 'asc' })
    expect(patchFindManyMock.mock.calls[0][0].take).toBe(1000)
    expect(getDocumentsMock.mock.calls[0][0]).toMatchObject({
      fields: ['id', 'docHash'],
      limit: 1000,
      offset: 0
    })
  })

  it('索引分多页时逐页读完', async () => {
    getDocumentsMock
      .mockResolvedValueOnce({ results: [{ id: 1, docHash: 'x' }], total: 2 })
      .mockResolvedValueOnce({ results: [{ id: 2, docHash: 'y' }], total: 2 })
    pgBatches([])

    const drift = await detectSearchDrift()

    expect(getDocumentsMock.mock.calls.map(([args]) => args.offset)).toEqual([
      0, 1000
    ])
    expect(drift.extra).toEqual([1, 2])
  })

  it('分出缺失、多余、过时 (含还没有摘要的旧文档), 不调用任何写 API', async () => {
    const same = payload(1)
    const renamedTag = payload(2)
    const legacy = payload(3)
    const fresh = payload(4)
    indexHas([
      { id: 1, docHash: await hashOf(same) },
      { id: 2, docHash: await hashOf(renamedTag) },
      { id: 3 },
      { id: 9, docHash: 'orphan' }
    ])
    pgBatches([
      same,
      payload(2, { tag: [{ tag: { id: 1, name: '纯爱' } }] }),
      legacy,
      fresh
    ])

    const drift = await detectSearchDrift()

    expect(drift).toEqual({
      total: 4,
      missing: [4],
      extra: [9],
      stale: [2, 3]
    })
    expect(writeApiMock).not.toHaveBeenCalled()
  })

  it('计数变化 (下载、浏览) 不算过时: 那些由计数刷新任务写', async () => {
    const indexed = payload(1)
    indexHas([{ id: 1, docHash: await hashOf(indexed) }])
    pgBatches([payload(1, { download: 99, view: 1234, favorite_count: 5 })])

    expect((await detectSearchDrift()).stale).toEqual([])
  })

  it('冷门条目上绕过应用层的关联变化 (会社、别名) 被判为过时', async () => {
    const indexed = payload(1)
    indexHas([{ id: 1, docHash: await hashOf(indexed) }])
    pgBatches([
      payload(1, {
        company: [{ company: { id: 3, name: 'Yuzusoft' } }],
        alias: [{ name: '别名' }]
      })
    ])

    expect((await detectSearchDrift()).stale).toEqual([1])
  })

  it('一份文档构建抛错只算它过时, 不中止整次检测', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = payload(3)
    indexHas([
      { id: 1, docHash: 'x' },
      { id: 2, docHash: 'old' },
      { id: 3, docHash: await hashOf(ok) },
      { id: 9, docHash: 'orphan' }
    ])
    pgBatches([payload(1, { name: 'boom' }), payload(2), ok])

    const drift = await detectSearchDrift()

    expect(drift).toEqual({ total: 3, missing: [], extra: [9], stale: [1, 2] })
    vi.restoreAllMocks()
  })

  it('未配置 Meili 时抛错且不触碰数据库', async () => {
    getMeiliClientMock.mockReturnValue(null)

    await expect(detectSearchDrift()).rejects.toThrow('未配置')
    expect(patchFindManyMock).not.toHaveBeenCalled()
  })
})

describe('reconcileSearchIndex 检测 + 入箱', () => {
  it('三类 id 一起按对账模式入箱, 多余的文档也只入箱、不直接删除', async () => {
    const stale = payload(2)
    indexHas([
      { id: 2, docHash: 'old' },
      { id: 9, docHash: 'orphan' }
    ])
    pgBatches([payload(1), stale])

    const result = await reconcileSearchIndex()

    expect(result).toEqual({ total: 2, missing: 1, extra: 1, stale: 1 })
    expect(enqueueBatchMock).toHaveBeenCalledTimes(1)
    const [, ids, options] = enqueueBatchMock.mock.calls[0]
    expect([...ids].sort()).toEqual([1, 2, 9])
    expect(options).toEqual({ mode: 'reconcile' })
    expect(writeApiMock).not.toHaveBeenCalled()
  })

  it('没有漂移时入箱的是空数组 (入箱函数对空数组不触库)', async () => {
    const row = payload(1)
    indexHas([{ id: 1, docHash: await hashOf(row) }])
    pgBatches([row])

    const result = await reconcileSearchIndex()

    expect(result).toEqual({ total: 1, missing: 0, extra: 0, stale: 0 })
    expect(enqueueBatchMock.mock.calls[0][1]).toEqual([])
  })
})
