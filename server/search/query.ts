import { createHash } from 'crypto'
import { getMeiliClient } from '~/lib/meilisearch'
import { getKv, setKv } from '~/lib/redis'
import { SEARCH_TOTAL_HITS_CACHE_DURATION } from '~/config/cache'
import { GALGAME_INDEX, GALGAME_MAX_TOTAL_HITS } from './settings'
import { MeiliProtocolError, summarizeMeiliError } from './failure'

// 超时即中止请求, 由 withMeiliEngine 归为 Meilisearch 不可用并换到 basic 引擎
export const SEARCH_QUERY_TIMEOUT_MS = 800

// 相关性下限（_rankingScore 0..1）：仅在有查询词时生效，剔除勉强命中的长尾。
// 上线后按零结果/噪声查询校准，调高更严、调低更全
export const SEARCH_RANKING_SCORE_THRESHOLD = 0.4

export interface GalgameIndexQuery {
  q?: string
  filter?: string
  sort?: string[]
  page: number
  hitsPerPage: number
  attributesToSearchOn?: string[]
}

// 精确总数只取决于检索条件、与页码无关：翻页与热词重复查询共享同一份计数，
// 命中缓存即可跳过 hitsPerPage=maxTotalHits 的全候选打分计数查询。
const buildTotalHitsCacheKey = (query: GalgameIndexQuery): string => {
  const parts = [
    query.q ?? '',
    query.filter ?? '',
    (query.sort ?? []).join(','),
    (query.attributesToSearchOn ?? []).join(',')
  ].join('|')
  const hash = createHash('sha1').update(parts).digest('hex').slice(0, 16)
  return `search:total:${hash}`
}

const readTotalHitsCache = async (cacheKey: string): Promise<number | null> => {
  try {
    const cached = await getKv(cacheKey)
    if (!cached) {
      return null
    }
    const parsed = Number(cached)
    return Number.isFinite(parsed) ? parsed : null
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('读取搜索计数缓存失败:', error)
    return null
  }
}

const writeTotalHitsCache = async (cacheKey: string, totalHits: number) => {
  try {
    await setKv(cacheKey, String(totalHits), SEARCH_TOTAL_HITS_CACHE_DURATION)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('写入搜索计数缓存失败:', error)
  }
}

interface IdSearchResult {
  hits: { id: number }[]
  totalHits: number
}

const isSearchResult = (value: unknown): value is IdSearchResult =>
  typeof value === 'object' &&
  value !== null &&
  'hits' in value &&
  Array.isArray(value.hits) &&
  'totalHits' in value &&
  typeof value.totalHits === 'number'

// 索引是召回层: 只回答「哪些 id、按什么顺序、一共多少」。卡片内容与可见性由调用方拿着
// id 回 PG 裁决 (server/galgame/cards.ts), 这个模块不读文档的其他字段, 也不碰 prisma。
// filter 里的分级 / 屏蔽标签只是召回预筛: 索引陈旧时 total 会把 PG 已不认的条目也算进去。
// 主查询取当前页的 id；有相关性阈值时另需精确总数（见下），优先读缓存、未命中才发计数查询。
export const queryGalgameIds = async (
  query: GalgameIndexQuery
): Promise<{ ids: number[]; total: number }> => {
  const client = getMeiliClient()
  if (!client) {
    throw new Error('Meilisearch client 未配置')
  }

  const index = client.index<{ id: number }>(GALGAME_INDEX)
  // 纯筛选/浏览端点 q 为空、所有文档得分 1.0，阈值不生效；仅约束有文字搜索的场景
  const rankingScoreThreshold = query.q
    ? SEARCH_RANKING_SCORE_THRESHOLD
    : undefined

  // 主查询与计数查询共享的检索条件。sort 必须一并共享：Meili 的 rankingRules 含 "sort"
  // 阶段，传入 sort 会改变 _rankingScore，从而改变 rankingScoreThreshold 的过阈值集合
  //（实测同一 q 带 sort 过 47 条、不带过 36 条）。两查询同 sort，total 才与主查询实际可翻的
  // 分页条数一致，否则计数偏小会把末页结果吃掉。
  const baseOptions = {
    filter: query.filter || undefined,
    sort: query.sort && query.sort.length > 0 ? query.sort : undefined,
    attributesToSearchOn: query.attributesToSearchOn,
    // 与 basic 引擎的多关键词 AND 语义对齐
    matchingStrategy: 'all' as const,
    rankingScoreThreshold
  }

  // 一次带超时的索引查询。SDK 只把非 2xx 的应答说成 MeilisearchApiError: 2xx 但正文不是
  // JSON 时它原样抛出 SyntaxError, 正文为空或缺字段时照常 resolve。这两种应答都不是
  // Meilisearch 给的 (地址指到了别的服务), 在这里说成 MeiliProtocolError, 归「没配好」,
  // 不让它们看上去像代码自己的错
  const search = async (page: {
    page: number
    hitsPerPage: number
    attributesToRetrieve: string[]
  }) => {
    let res: unknown
    try {
      res = await index.search(
        query.q ?? '',
        { ...baseOptions, ...page },
        { signal: AbortSignal.timeout(SEARCH_QUERY_TIMEOUT_MS) }
      )
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new MeiliProtocolError('Meilisearch 的应答不是 JSON', error)
      }
      throw error
    }
    if (!isSearchResult(res)) {
      throw new MeiliProtocolError('Meilisearch 的应答缺少 hits / totalHits')
    }
    return res
  }

  // 主查询：取当前页的 id
  const mainSearch = async () => {
    const res = await search({
      page: query.page,
      hitsPerPage: query.hitsPerPage,
      attributesToRetrieve: ['id']
    })
    return { ids: res.hits.map((hit) => hit.id), totalHits: res.totalHits }
  }

  // 浏览态（无阈值）：Meili 的 totalHits 本就精确，无需计数查询
  if (rankingScoreThreshold === undefined) {
    const res = await mainSearch()
    return { ids: res.ids, total: res.totalHits }
  }

  // 设了 rankingScoreThreshold 后，Meili 有限分页的 totalHits 只穷举到当前页窗为止：
  // 浅页返回"阈值过滤前"的候选数（偏大），翻到阈值截断处才崩塌 —— 页数会随翻页缩水。
  // 需一个 hitsPerPage=maxTotalHits 的计数查询强制其对全部候选打分，拿到阈值之上的精确总数。
  // 该总数与页码无关：优先读缓存，命中即跳过这条昂贵查询，只发主查询。
  const cacheKey = buildTotalHitsCacheKey(query)
  const cachedTotal = await readTotalHitsCache(cacheKey)
  if (cachedTotal !== null) {
    const res = await mainSearch()
    return { ids: res.ids, total: cachedTotal }
  }

  // 缓存未命中：主查询与计数查询并行。主查询先发起，保持"主先计数后"的调用顺序。
  // 计数查询单独兜底 —— 它超时/失败时回退到主查询的 totalHits（浅页偏大的近似值），
  // 绝不因此拒绝整次搜索、把成功的主查询结果连带丢弃并换到 basic 引擎
  //（那会在 Meili 高负载期把最重的多 OR/join 查询倾泻到有限连接池上，酿成级联）。
  const mainPromise = mainSearch()
  const countPromise = search({
    page: 1,
    hitsPerPage: GALGAME_MAX_TOTAL_HITS,
    // 只需要 totalHits：空数组让每个 hit 回传为 {}，常见词命中数千候选时
    // 比 ['id'] 省约 75% 传输（实测 の：71KB→17.5KB）
    attributesToRetrieve: []
  }).then(
    (counted) => ({ totalHits: counted.totalHits }),
    (error: unknown) => ({ error })
  )

  // 主查询失败时这里直接抛出, 由 withMeiliEngine 归类并记日志: 计数查询多半是同一个原因
  // 失败的, 不再为它另记一条
  const [res, count] = await Promise.all([mainPromise, countPromise])

  if ('error' in count) {
    // 主查询成功而计数查询单独失败 (它要对全部候选打分, 更容易撞超时)
    // eslint-disable-next-line no-console
    console.warn(
      '[kun-search] 计数查询失败, 总数用主查询的近似值:',
      summarizeMeiliError(count.error)
    )
    // 近似值不入缓存, 避免把偏大的估算固化 60s
    return { ids: res.ids, total: res.totalHits }
  }

  // 写入 fire-and-forget：数据已算完，不为一次 Redis 写（最坏 2s commandTimeout）拖尾延迟；
  // writeTotalHitsCache 内部已吞异常，void 不产生 unhandled rejection
  void writeTotalHitsCache(cacheKey, count.totalHits)

  return { ids: res.ids, total: count.totalHits }
}
