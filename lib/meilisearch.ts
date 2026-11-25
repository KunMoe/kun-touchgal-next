import { Meilisearch } from 'meilisearch'

let client: Meilisearch | null = null

// 单次 HTTP 请求的上界。没有它, 写入 (出箱 drain、计数刷新、settings 下发) 的入队 POST 卡住时
// 只受 undici 默认的 300 秒约束。SDK 只对没带 signal 的请求套用它: 查询侧 (server/search/query.ts)
// 自带更短的 signal, 不受影响。超时抛 MeilisearchRequestError, drain 按引擎整体故障处理
const MEILI_REQUEST_TIMEOUT_MS = 30_000

export const getMeiliClient = () => {
  const host = process.env.MEILISEARCH_HOST
  const apiKey = process.env.MEILISEARCH_ADMIN_API_KEY
  if (!host || !apiKey) {
    return null
  }
  if (!client) {
    client = new Meilisearch({
      host,
      apiKey,
      timeout: MEILI_REQUEST_TIMEOUT_MS
    })
  }
  return client
}

export const isMeiliEnabled = () =>
  process.env.KUN_MEILISEARCH_ENABLED === 'true' && !!getMeiliClient()
