import { evalKvScript, getKv } from '~/lib/redis'
import type { UnreadSnapshot } from '~/types/api/message'

const MESSAGE_UNREAD_CACHE_TTL_SECONDS = 30

const getMessageUnreadCacheKey = (uid: number) => `message:unread:${uid}`

// 条目都带时刻 asOf: 快照是算它的查询开始的时刻, 失效写的墓碑是失效那一刻。只让更新的条目
// 写进去 —— 查询早于某次写入提交的请求, 晚于那次失效才把结果写回缓存时, 墓碑或已读接口刚写的
// 新快照的时刻都比它新, 旧值写不进去 (否则 30 秒内刷新、新标签页都会读回已读之前的红点)。
// 快照要严格更新才写 (同一毫秒的快照可能早于失效); 墓碑不早于已存的就写。没有时刻的旧条目算 0,
// 解析不了的直接覆盖。语义由真 Redis 契约用例守护 (__tests__/cache.redis.test.ts)
const SET_IF_NEWER = `
local current = redis.call("get", KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == "table" then
    local currentAsOf = tonumber(decoded.asOf) or 0
    local nextAsOf = tonumber(ARGV[2])
    if currentAsOf > nextAsOf or (currentAsOf == nextAsOf and ARGV[4] ~= "1") then
      return 0
    end
  end
end
redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[3])
return 1
`

const setIfNewer = (
  uid: number,
  value: object,
  asOf: number,
  isInvalidation: boolean
) =>
  evalKvScript<number>(
    SET_IF_NEWER,
    [getMessageUnreadCacheKey(uid)],
    [
      JSON.stringify(value),
      asOf,
      MESSAGE_UNREAD_CACHE_TTL_SECONDS,
      isInvalidation ? 1 : 0
    ]
  )

export const getCachedUnread = async (
  uid: number
): Promise<UnreadSnapshot | null> => {
  const cached = await getKv(getMessageUnreadCacheKey(uid))
  if (!cached) {
    return null
  }

  try {
    // 墓碑没有这两个字段, 读作未命中
    const status = JSON.parse(cached) as Partial<UnreadSnapshot>
    if (
      typeof status.hasUnreadNotification !== 'boolean' ||
      typeof status.hasUnreadConversation !== 'boolean'
    ) {
      return null
    }

    return {
      hasUnreadNotification: status.hasUnreadNotification,
      hasUnreadConversation: status.hasUnreadConversation,
      // 带时刻之前写进缓存的条目算最旧: 客户端已有的任何快照都不会被它盖掉
      asOf: typeof status.asOf === 'number' ? status.asOf : 0
    }
  } catch {
    return null
  }
}

export const setCachedUnread = async (uid: number, status: UnreadSnapshot) => {
  await setIfNewer(uid, status, status.asOf, false)
}

// 在写入提交之后调用: 墓碑的时刻晚于提交, 之前开始的查询都写不回来
export const invalidateUnread = async (uid: number) => {
  try {
    const asOf = Date.now()
    await setIfNewer(uid, { invalidated: true, asOf }, asOf, true)
  } catch {
    // 失效失败不应阻断已读响应; 短 TTL 会在数十秒内兜底自愈
  }
}
