import { acquireKvLock, releaseKvLock } from '~/lib/redis'
import { kunLog } from '~/lib/log.server'

const CACHE_SINGLEFLIGHT_LOCK_TTL_SECONDS = 10
// 递进退避: 首次延迟刻意非零 (调用方刚读到 miss, 立即重读几乎必再 miss),
// 快查询在首次 50ms 即可命中; 后续延迟拉长以覆盖慢查询降级窗口
const CACHE_SINGLEFLIGHT_RETRY_DELAYS_MS = [50, 150, 250]

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// 与各缓存读 helper 的返回形状一致: canWrite=false 表示 Redis 读故障
export interface KunCacheReadResult<T> {
  response: T | null
  canWrite: boolean
}

interface KunCacheSingleflightOptions<T> {
  cacheKey: string
  readCache: () => Promise<KunCacheReadResult<T>>
  writeCache: (response: T) => Promise<void>
  writeCacheIfAbsent: (response: T) => Promise<void>
  query: () => Promise<T>
}

// 单飞: 缓存未命中时仅持锁者回源并写缓存, 其余请求短暂等待后重读缓存。
// 调用方需先处理缓存命中与不可写 (canWrite=false / 不缓存视角) 的分支。
export const kunCacheSingleflight = async <T>({
  cacheKey,
  readCache,
  writeCache,
  writeCacheIfAbsent,
  query
}: KunCacheSingleflightOptions<T>): Promise<T> => {
  const lockKey = `${cacheKey}:lock`
  let lockToken: string | null
  try {
    lockToken = await acquireKvLock(
      lockKey,
      CACHE_SINGLEFLIGHT_LOCK_TTL_SECONDS
    )
  } catch (error) {
    // Redis 异常不同于锁竞争, 直接回源, 不进入等待循环
    kunLog(
      'cache.degraded',
      { ns: 'singleflight', op: 'lock', key: cacheKey },
      error
    )
    return query()
  }

  if (!lockToken) {
    for (const delayMs of CACHE_SINGLEFLIGHT_RETRY_DELAYS_MS) {
      await sleep(delayMs)
      const retried = await readCache()
      if (retried.response !== null) {
        return retried.response
      }
      // 读故障 (canWrite=false) 说明 Redis 已不可用, 走完剩余重试梯只会
      // 空耗 (挂起型故障下每次读最坏撞满 commandTimeout), 立即回源
      if (!retried.canWrite) {
        break
      }
    }
    // 等待超时 (持锁者异常或查询过慢), 直接回源保证可用,
    // 并以 NX 回写补位缺席的持锁者, 避免锁 TTL 内缓存持续为空
    const response = await query()
    void writeCacheIfAbsent(response).catch((error) => {
      kunLog(
        'cache.degraded',
        { ns: 'singleflight', op: 'write_fallback', key: cacheKey },
        error
      )
    })
    return response
  }

  try {
    // 调用方首次读到 miss 后, 前一持锁者可能已完成写入并释放锁
    const cached = await readCache()
    if (cached.response !== null) {
      return cached.response
    }

    const response = await query()
    // 写缓存失败 (Redis 故障) 不应使请求失败, 与上方 writeCacheIfAbsent 分支对齐
    await writeCache(response).catch((error) => {
      kunLog(
        'cache.degraded',
        { ns: 'singleflight', op: 'write', key: cacheKey },
        error
      )
    })
    return response
  } finally {
    // 锁有 TTL 自愈且释放带 token 校验, 无需阻塞响应等待释放
    void releaseKvLock(lockKey, lockToken).catch(() => undefined)
  }
}
