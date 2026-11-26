import { randomUUID } from 'crypto'
import { delKv, getKv, setKv, setKvIfAbsent } from '~/lib/redis'
import { kunLog } from '~/lib/log.server'
import { COMMENT_CACHE_DURATION } from '~/config/cache'
import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'
import type { PatchComment } from '~/types/api/patch'

const COMMENT_CACHE_KEY = 'patch:comment'
const COMMENT_CACHE_VERSION_KEY = 'patch:comment:version'
const COMMENT_CACHE_DEFAULT_VERSION = '0'

// 共享缓存承载的是 status=0 公开基线分页 (isLike 全 false),
// 调用方命中后再按 uid 叠加 isLike, 管理员与有自己待审评论的用户走非缓存路径
export interface PatchCommentPage {
  comments: PatchComment[]
  total: number
}

const getCommentCacheVersionKey = (patchId: number) =>
  `${COMMENT_CACHE_VERSION_KEY}:${patchId}`

// r0 为 patch 评论区, rN 为资源详情页评论区; 版本键仍按 patchId 分片,
// 任一侧写入触发的版本跳变会同时失效两侧分页键
const getCommentCacheKey = (
  patchId: number,
  resourceId: number | null,
  version: string,
  page: number,
  limit: number
) =>
  `${COMMENT_CACHE_KEY}:${patchId}:r${resourceId ?? 0}:v${version}:p${page}:l${limit}`

const logCommentCacheError = (message: string, error: unknown) => {
  kunLog('cache.degraded', { ns: 'patch:comment', op: message }, error)
}

interface CommentPageCacheResult {
  response: PatchCommentPage | null
  canWrite: boolean
}

const readCommentPageCache = async (
  cacheKey: string
): Promise<CommentPageCacheResult> => {
  let cached: string | null

  try {
    cached = await getKv(cacheKey)
  } catch (error) {
    logCommentCacheError('Failed to read patch comment cache:', error)
    return { response: null, canWrite: false }
  }

  if (!cached) {
    return { response: null, canWrite: true }
  }

  try {
    return { response: JSON.parse(cached) as PatchCommentPage, canWrite: true }
  } catch (error) {
    logCommentCacheError('Failed to parse patch comment cache:', error)
    try {
      await delKv(cacheKey)
    } catch (deleteError) {
      logCommentCacheError(
        'Failed to delete invalid patch comment cache:',
        deleteError
      )
    }
    return { response: null, canWrite: true }
  }
}

const setCommentPageCache = async (
  cacheKey: string,
  response: PatchCommentPage
) => {
  try {
    await setKv(cacheKey, JSON.stringify(response), COMMENT_CACHE_DURATION)
  } catch (error) {
    logCommentCacheError('Failed to write patch comment cache:', error)
  }
}

const setCommentPageCacheIfAbsent = async (
  cacheKey: string,
  response: PatchCommentPage
) => {
  try {
    await setKvIfAbsent(
      cacheKey,
      JSON.stringify(response),
      COMMENT_CACHE_DURATION
    )
  } catch (error) {
    logCommentCacheError('Failed to write patch comment cache:', error)
  }
}

export const withPatchCommentPageCache = async (
  patchId: number,
  resourceId: number | null,
  page: number,
  limit: number,
  query: () => Promise<PatchCommentPage>
): Promise<PatchCommentPage> => {
  let version: string
  try {
    version =
      (await getKv(getCommentCacheVersionKey(patchId))) ??
      COMMENT_CACHE_DEFAULT_VERSION
  } catch (error) {
    // 版本号读失败直接回源, 不进入单飞, 避免阻塞
    logCommentCacheError('Failed to read patch comment cache version:', error)
    return query()
  }

  const cacheKey = getCommentCacheKey(patchId, resourceId, version, page, limit)

  const cached = await readCommentPageCache(cacheKey)
  if (cached.response) {
    return cached.response
  }

  // 缓存读失败 (canWrite=false) 不参与单飞, 避免阻塞在锁上
  if (!cached.canWrite) {
    return query()
  }

  return kunCacheSingleflight({
    cacheKey,
    readCache: () => readCommentPageCache(cacheKey),
    writeCache: (response) => setCommentPageCache(cacheKey, response),
    writeCacheIfAbsent: (response) =>
      setCommentPageCacheIfAbsent(cacheKey, response),
    query
  })
}

// 版本号自增使旧分页键一次性全部失效, 陈旧键随 TTL 自然过期
export const invalidatePatchCommentCache = async (patchId: number) => {
  try {
    await setKv(getCommentCacheVersionKey(patchId), randomUUID())
  } catch (error) {
    logCommentCacheError('Failed to invalidate patch comment cache:', error)
  }
}
