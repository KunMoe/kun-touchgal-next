import { createHash } from 'crypto'
import { getMeiliClient } from '~/lib/meilisearch'
import { getKv, setKv } from '~/lib/redis'
import { SEARCH_TOTAL_HITS_CACHE_DURATION } from '~/config/cache'
import { GALGAME_INDEX, GALGAME_MAX_TOTAL_HITS } from './settings'

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

  // 主查询：取当前页的 id
  const mainSearch = async () => {
    const res = await index.search(
      query.q ?? '',
      {
        ...baseOptions,
        page: query.page,
        hitsPerPage: query.hitsPerPage,
        attributesToRetrieve: ['id']
      },
      { signal: AbortSignal.timeout(SEARCH_QUERY_TIMEOUT_MS) }
    )
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
  const countPromise = index
    .search(
      query.q ?? '',
      {
        ...baseOptions,
        page: 1,
        hitsPerPage: GALGAME_MAX_TOTAL_HITS,
        // 只需要 totalHits：空数组让每个 hit 回传为 {}，常见词命中数千候选时
        // 比 ['id'] 省约 75% 传输（实测 の：71KB→17.5KB）
        attributesToRetrieve: []
      },
      { signal: AbortSignal.timeout(SEARCH_QUERY_TIMEOUT_MS) }
    )
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('计数查询失败，回退到主查询 totalHits（近似）:', error)
      return null
    })

  const [res, count] = await Promise.all([mainPromise, countPromise])

  // 仅精确总数才入缓存；近似回退值不写，避免把降级期的偏大估算固化 60s。
  // 写入 fire-and-forget：数据已算完，不为一次 Redis 写（最坏 2s commandTimeout）拖尾延迟；
  // writeTotalHitsCache 内部已吞异常，void 不产生 unhandled rejection
  if (count) {
    void writeTotalHitsCache(cacheKey, count.totalHits)
  }

  return { ids: res.ids, total: count ? count.totalHits : res.totalHits }
}
