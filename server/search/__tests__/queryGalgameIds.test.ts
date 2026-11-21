import { beforeEach, describe, expect, it, vi } from 'vitest'

// 隔离 Meilisearch 客户端与 Redis：queryGalgameIds 依赖 getMeiliClient 和 totalHits 缓存
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
  queryGalgameIds,
  SEARCH_RANKING_SCORE_THRESHOLD
} from '~/server/search/query'
import { GALGAME_MAX_TOTAL_HITS } from '~/server/search/settings'

// 主查询只回取 id: Meilisearch 按 attributesToRetrieve 裁剪后的命中
const sampleHit = { id: 1 }

describe('queryGalgameIds 分页总数', () => {
  beforeEach(() => {
    searchMock.mockReset()
    // 默认缓存未命中，现有用例照常发主查询 + 计数查询
    getKvMock.mockReset().mockResolvedValue(null)
    setKvMock.mockReset().mockResolvedValue(undefined)
  })

  // 索引只是召回层: 卡片与可见性由调用方回 PG 裁决, 这里不取文档的其他字段。
  // 把别的字段加回 attributesToRetrieve 就又多出一个不经 toGalgameCard 的卡片来源
  it('主查询只回取 id, 结果按命中顺序给出 { ids, total }', async () => {
    searchMock.mockResolvedValue({
      hits: [{ id: 7 }, { id: 3 }, { id: 9 }],
      totalHits: 50
    })

    const result = await queryGalgameIds({
      q: '',
      filter: "type = 'pc'",
      sort: ['created:desc', 'id:desc'],
      page: 2,
      hitsPerPage: 12
    })

    expect(result).toEqual({ ids: [7, 3, 9], total: 50 })
    expect(searchMock).toHaveBeenCalledTimes(1)
    expect(searchMock.mock.calls[0][1]).toEqual({
      filter: "type = 'pc'",
      sort: ['created:desc', 'id:desc'],
      attributesToSearchOn: undefined,
      matchingStrategy: 'all',
      rankingScoreThreshold: undefined,
      page: 2,
      hitsPerPage: 12,
      attributesToRetrieve: ['id']
    })
  })

  it('有查询词且计数缓存命中或未命中时, 主查询同样只回取 id', async () => {
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.resolve(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? { hits: [], totalHits: 2 }
            : { hits: [{ id: 5 }, { id: 4 }], totalHits: 9 }
        )
    )

    const miss = await queryGalgameIds({ q: 'atri', page: 1, hitsPerPage: 12 })
    getKvMock.mockResolvedValue('2')
    const hit = await queryGalgameIds({ q: 'atri', page: 1, hitsPerPage: 12 })

    expect(miss).toEqual({ ids: [5, 4], total: 2 })
    expect(hit).toEqual({ ids: [5, 4], total: 2 })
    const mainCalls = searchMock.mock.calls.filter(
      ([, options]) => options.hitsPerPage === 12
    )
    expect(mainCalls).toHaveLength(2)
    for (const [, options] of mainCalls) {
      expect(options.attributesToRetrieve).toEqual(['id'])
    }
  })

  it('有查询词时用计数查询的精确 totalHits，而非主查询浅页高估值', async () => {
    // 主查询（hitsPerPage=12）浅页返回阈值过滤前的 148；
    // 计数查询（hitsPerPage=maxTotalHits）返回阈值之上的真实 36。
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.resolve(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? { hits: [], totalHits: 36 }
            : { hits: [sampleHit], totalHits: 148 }
        )
    )

    const result = await queryGalgameIds({
      q: 'atri',
      filter: "contentLimit = 'sfw'",
      sort: ['created:desc'],
      page: 1,
      hitsPerPage: 12
    })

    expect(result.total).toBe(36)
    expect(result.ids).toEqual([1])
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

    const page1 = await queryGalgameIds({
      q: 'atri',
      filter: '',
      page: 1,
      hitsPerPage: 12
    })
    const page4 = await queryGalgameIds({
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
            : { hits: [sampleHit], totalHits: 148 }
        )
    )

    await queryGalgameIds({
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
    searchMock.mockResolvedValue({ hits: [sampleHit], totalHits: 50 })

    const result = await queryGalgameIds({
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

  it('主查询失败时原样抛出, 计数查询跟着失败也不另记日志', async () => {
    // 两条查询多半是同一个原因失败的: 归类与日志交给 withMeiliEngine, 这里再记一条
    // 只会把故障期的每次搜索变成两条日志 (匿名的非法请求也能刷出一条)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mainFailure = Object.assign(new Error('stub malformed_payload'), {
      name: 'MeilisearchApiError',
      response: { status: 400 },
      cause: { code: 'malformed_payload' }
    })
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.reject(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? new Error('count failed too')
            : mainFailure
        )
    )

    await expect(
      queryGalgameIds({ q: 'atri', page: 1, hitsPerPage: 12 })
    ).rejects.toBe(mainFailure)
    // 让计数查询的拒绝也落定
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('主查询成功而计数查询单独失败: 只记一条摘要 (warn)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
          ? Promise.reject(
              Object.assign(new Error('Request to http://meili has failed'), {
                name: 'MeilisearchRequestError',
                cause: new DOMException('timed out', 'TimeoutError')
              })
            )
          : Promise.resolve({ hits: [sampleHit], totalHits: 148 })
    )

    const result = await queryGalgameIds({
      q: 'atri',
      page: 1,
      hitsPerPage: 12
    })

    expect(result).toEqual({ ids: [1], total: 148 })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.any(String), {
      name: 'MeilisearchRequestError',
      message: 'Request to http://meili has failed',
      cause: 'TimeoutError'
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // SDK 对 2xx 但正文不是 JSON 的应答原样抛 SyntaxError, 正文为空或缺字段时照常 resolve
  // (failure.test.ts 用真实 SDK 钉住)。这些都不是 Meilisearch 的搜索结果
  it.each([
    [
      'SDK 抛 SyntaxError',
      () => Promise.reject(new SyntaxError('Unexpected token <'))
    ],
    ['应答是 undefined', () => Promise.resolve(undefined)],
    ['应答是 {}', () => Promise.resolve({})],
    ['hits 不是数组', () => Promise.resolve({ hits: 'x', totalHits: 1 })],
    ['缺 totalHits', () => Promise.resolve({ hits: [] })]
  ])(
    '应答不是 Meilisearch 的搜索结果 (%s): 抛 MeiliProtocolError',
    async (_name, respond) => {
      searchMock.mockImplementation(respond)

      const thrown = await queryGalgameIds({
        q: '',
        page: 1,
        hitsPerPage: 12
      }).catch((error: unknown) => error)

      expect((thrown as Error).name).toBe('MeiliProtocolError')
    }
  )

  it('SDK 抛出的其他错误原样抛出, 不改名', async () => {
    const failure = Object.assign(new Error('stub'), {
      name: 'MeilisearchApiError'
    })
    searchMock.mockRejectedValue(failure)

    await expect(
      queryGalgameIds({ q: '', page: 1, hitsPerPage: 12 })
    ).rejects.toBe(failure)
  })

  it('计数查询失败时回退到主查询 totalHits，不拒绝整次搜索、不写缓存', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 主查询成功返回浅页高估 148；计数查询超时/失败（reject）。
    // 期望：不抛错、total 退化为主查询近似值 148，且近似值不入缓存（不污染后续 60s）。
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
          ? Promise.reject(new Error('count timeout'))
          : Promise.resolve({ hits: [sampleHit], totalHits: 148 })
    )

    const result = await queryGalgameIds({
      q: 'atri',
      filter: '',
      page: 1,
      hitsPerPage: 12
    })

    expect(result.total).toBe(148)
    expect(result.ids).toEqual([1])
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('totalHits 命中缓存时跳过计数查询，且与页码无关', async () => {
    searchMock.mockImplementation(
      (_q: string, options: { hitsPerPage: number }) =>
        Promise.resolve(
          options.hitsPerPage === GALGAME_MAX_TOTAL_HITS
            ? { hits: [], totalHits: 36 }
            : { hits: [sampleHit], totalHits: 148 }
        )
    )

    // 首次：缓存未命中 → 主查询 + 计数查询，精确 total=36 写入缓存
    const first = await queryGalgameIds({
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
    const second = await queryGalgameIds({
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
            : { hits: [sampleHit], totalHits: 148 }
        )
    )

    await queryGalgameIds({
      q: 'atri',
      filter: "contentLimit = 'sfw'",
      page: 1,
      hitsPerPage: 12
    })
    await queryGalgameIds({ q: 'atri', filter: '', page: 1, hitsPerPage: 12 })
    expect(getKvMock.mock.calls[0][0]).not.toBe(getKvMock.mock.calls[1][0])

    // 相同检索条件、不同页 → 同键（totalHits 页无关，翻页复用）。
    // 若日后把 page/hitsPerPage 混进键造成碎片化，两键不等，本例即红。
    getKvMock.mockClear()
    await queryGalgameIds({ q: 'atri', filter: '', page: 1, hitsPerPage: 12 })
    await queryGalgameIds({ q: 'atri', filter: '', page: 5, hitsPerPage: 12 })
    expect(getKvMock.mock.calls[0][0]).toBe(getKvMock.mock.calls[1][0])
  })
})
