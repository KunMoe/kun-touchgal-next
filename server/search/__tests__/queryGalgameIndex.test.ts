import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GalgameSearchDoc } from '~/server/search/document'

// 隔离 Meilisearch 客户端与 Redis：queryGalgameIndex 依赖 getMeiliClient 和 totalHits 缓存
const { searchMock, getKvMock, setKvMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  getKvMock: vi.fn(),
  setKvMock: vi.fn()
}))
vi.mock('~/lib/meilisearch', () => ({
  getMeiliClient: () => ({ index: () => ({ search: searchMock }) }),
  isMeiliEnabled: () => true
}))
vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock
}))

import {
  queryGalgameIndex,
  SEARCH_RANKING_SCORE_THRESHOLD
} from '~/server/search/query'
import { GALGAME_MAX_TOTAL_HITS } from '~/server/search/settings'

const sampleDoc: GalgameSearchDoc = {
  id: 1,
  uniqueId: 'atri0001',
  name: 'ATRI',
  banner: 'atri.avif',
  alias: [],
  tag: ['科幻'],
  company: [],
  introduction: '',
  vndbId: null,
  vndbRelationId: null,
  dlsiteCode: null,
  tagIds: [1],
  companyIds: [],
  type: ['pc'],
  language: ['zh-Hans'],
  platform: ['windows'],
  contentLimit: 'sfw',
  releasedYear: '2020',
  releasedMonth: '06',
  releasedSort: 20200619,
  created: Math.floor(new Date('2020-06-19T00:00:00Z').getTime() / 1000),
  updated: Math.floor(new Date('2020-06-19T00:00:00Z').getTime() / 1000),
  resourceUpdateTime: Math.floor(
    new Date('2020-06-19T00:00:00Z').getTime() / 1000
  ),
  view: 1,
  download: 1,
  favoriteCount: 1,
  resourceCount: 1,
  commentCount: 1,
  ratingCount: 1,
  avgRating: 8
}

describe('queryGalgameIndex 分页总数', () => {
  beforeEach(() => {
    searchMock.mockReset()
    // 默认缓存未命中，现有用例照常发主查询 + 计数查询
    getKvMock.mockReset().mockResolvedValue(null)
    setKvMock.mockReset().mockResolvedValue(undefined)
  })

  it('有查询词时用计数查询的精确 totalHits，而非主查询浅页高估值', async () => {
    // 主查询（hitsPerPage=12）浅页返回阈值过滤前的 148；
    // 计数查询（hitsPerPage=maxTotalHits）返回阈值之上的真实 36。
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.resolve(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? { hits: [], totalHits: 36 }
            : { hits: [sampleDoc], totalHits: 148 }
        )
    )

    const result = await queryGalgameIndex({
      q: 'atri',
      filter: "contentLimit = 'sfw'",
      sort: ['created:desc'],
      page: 1,
      hitsPerPage: 12
    })

    expect(result.total).toBe(36)
    expect(result.galgames).toHaveLength(1)
    expect(searchMock).toHaveBeenCalledTimes(2)
    // 第二次为计数查询：整库上限的 hitsPerPage、只取 id、复用同一阈值
    expect(searchMock).toHaveBeenNthCalledWith(
      2,
      'atri',
      expect.objectContaining({
        page: 1,
        hitsPerPage: GALGAME_MAX_TOTAL_HITS,
        attributesToRetrieve: [],
        // 计数查询必须复用主查询的 sort（sort 影响 _rankingScore → 过阈值集合）
        sort: ['created:desc'],
        rankingScoreThreshold: SEARCH_RANKING_SCORE_THRESHOLD
      }),
      expect.anything()
    )
  })

  it('翻到不同页，total 恒等于计数查询结果（不随页漂移）', async () => {
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.resolve(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? { hits: [], totalHits: 36 }
            : { hits: [], totalHits: 148 }
        )
    )

    const page1 = await queryGalgameIndex({
      q: 'atri',
      filter: '',
      page: 1,
      hitsPerPage: 12
    })
    const page4 = await queryGalgameIndex({
      q: 'atri',
      filter: '',
      page: 4,
      hitsPerPage: 12
    })

    expect(page1.total).toBe(36)
    expect(page4.total).toBe(36)
  })

  it('计数查询与主查询共享所有影响 _rankingScore 的参数（q/sort/matchingStrategy/attributesToSearchOn/阈值/filter）', async () => {
    // sort 会改变 Meili 的 _rankingScore，从而改变 rankingScoreThreshold 过滤后的
    // 结果集大小（实测同一 q 带 sort 47 条、不带 36 条）。计数查询与主查询任一参数
    // 不一致，total 就会与主查询实际可翻的分页条数错位，末页结果被计数吃掉。
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.resolve(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? { hits: [], totalHits: 47 }
            : { hits: [sampleDoc], totalHits: 148 }
        )
    )

    await queryGalgameIndex({
      q: 'atri',
      filter: "contentLimit = 'sfw'",
      sort: ['resourceUpdateTime:desc', 'id:desc'],
      attributesToSearchOn: ['name', 'alias'],
      page: 2,
      hitsPerPage: 12
    })

    const [mainQ, mainOpts] = searchMock.mock.calls[0]
    const [countQ, countOpts] = searchMock.mock.calls[1]
    expect(countQ).toBe(mainQ)
    expect(countOpts.sort).toEqual(mainOpts.sort)
    expect(countOpts.matchingStrategy).toBe(mainOpts.matchingStrategy)
    expect(countOpts.attributesToSearchOn).toEqual(
      mainOpts.attributesToSearchOn
    )
    expect(countOpts.rankingScoreThreshold).toBe(mainOpts.rankingScoreThreshold)
    expect(countOpts.filter).toBe(mainOpts.filter)
  })

  it('浏览态（q 为空）不触发计数查询，直接用主查询 totalHits 且不带阈值', async () => {
    searchMock.mockResolvedValue({ hits: [sampleDoc], totalHits: 50 })

    const result = await queryGalgameIndex({
      q: '',
      filter: "type = 'pc'",
      page: 1,
      hitsPerPage: 12
    })

    expect(result.total).toBe(50)
    expect(searchMock).toHaveBeenCalledTimes(1)
    expect(searchMock).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ rankingScoreThreshold: undefined }),
      expect.anything()
    )
  })

  it('计数查询失败时回退到主查询 totalHits，不拒绝整次搜索、不写缓存', async () => {
    // 主查询成功返回浅页高估 148；计数查询超时/失败（reject）。
    // 期望：不抛错、total 退化为主查询近似值 148，且近似值不入缓存（不污染后续 60s）。
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
          ? Promise.reject(new Error('count timeout'))
          : Promise.resolve({ hits: [sampleDoc], totalHits: 148 })
    )

    const result = await queryGalgameIndex({
      q: 'atri',
      filter: '',
      page: 1,
      hitsPerPage: 12
    })

    expect(result.total).toBe(148)
    expect(result.galgames).toHaveLength(1)
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('totalHits 命中缓存时跳过计数查询，且与页码无关', async () => {
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.resolve(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? { hits: [], totalHits: 36 }
            : { hits: [sampleDoc], totalHits: 148 }
        )
    )

    // 首次：缓存未命中 → 主查询 + 计数查询，精确 total=36 写入缓存
    const first = await queryGalgameIndex({
      q: 'atri',
      filter: '',
      page: 1,
      hitsPerPage: 12
    })
    expect(first.total).toBe(36)
    expect(searchMock).toHaveBeenCalledTimes(2)
    expect(setKvMock).toHaveBeenCalledOnce()
    const cachedValue = setKvMock.mock.calls[0][1]
    expect(cachedValue).toBe('36')

    // 再次：翻到不同页、命中缓存 → 只发主查询，跳过 20000 候选计数查询
    searchMock.mockClear()
    getKvMock.mockResolvedValueOnce(cachedValue)
    const second = await queryGalgameIndex({
      q: 'atri',
      filter: '',
      page: 3,
      hitsPerPage: 12
    })
    expect(second.total).toBe(36)
    expect(searchMock).toHaveBeenCalledTimes(1)
  })

  it('缓存键随 filter 变化（可见性隔离），但与页码无关', async () => {
    // filter 编码了可见性（contentLimit / 屏蔽标签）。它必须进缓存键，否则不同可见性的
    // 用户会命中同一份 totalHits —— 跨用户串味。此断言守护该不变量：若日后从
    // buildTotalHitsCacheKey 漏掉 filter，两键相等，本例即红。
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.resolve(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? { hits: [], totalHits: 36 }
            : { hits: [sampleDoc], totalHits: 148 }
        )
    )

    await queryGalgameIndex({
      q: 'atri',
      filter: "contentLimit = 'sfw'",
      page: 1,
      hitsPerPage: 12
    })
    await queryGalgameIndex({ q: 'atri', filter: '', page: 1, hitsPerPage: 12 })
    expect(getKvMock.mock.calls[0][0]).not.toBe(getKvMock.mock.calls[1][0])

    // 相同检索条件、不同页 → 同键（totalHits 页无关，翻页复用）。
    // 若日后把 page/hitsPerPage 混进键造成碎片化，两键不等，本例即红。
    getKvMock.mockClear()
    await queryGalgameIndex({ q: 'atri', filter: '', page: 1, hitsPerPage: 12 })
    await queryGalgameIndex({ q: 'atri', filter: '', page: 5, hitsPerPage: 12 })
    expect(getKvMock.mock.calls[0][0]).toBe(getKvMock.mock.calls[1][0])
  })
})
