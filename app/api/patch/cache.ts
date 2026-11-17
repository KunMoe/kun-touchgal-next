import { randomUUID } from 'crypto'
import { PATCH_FAVORITE_CACHE_DURATION } from '~/config/cache'
import { KUN_MARKDOWN_PROFILES } from '~/app/api/utils/render/profiles'
import { delKv, delKvs, getKv, getKvs, setKv } from '~/lib/redis'
import { prisma } from '~/prisma/index'

const PATCH_CACHE_KEY = 'patch'
const PATCH_INTRODUCTION_CACHE_KEY = 'patch:introduction'
const PATCH_FAVORITE_CACHE_KEY = 'patch:favorite'
const PATCH_FAVORITE_VERSION_KEY = 'patch:favorite:version'
const PATCH_FAVORITE_DEFAULT_VERSION = '0'

export const getPatchCacheKey = (uniqueId: string) =>
  `${PATCH_CACHE_KEY}:${uniqueId}`

export const getPatchIntroductionCacheKey = (uniqueId: string) =>
  `${PATCH_INTRODUCTION_CACHE_KEY}:v${KUN_MARKDOWN_PROFILES.introduction.version}:${uniqueId}`

const getPatchFavoriteCacheKey = (uniqueId: string, uid: number) =>
  `${PATCH_FAVORITE_CACHE_KEY}:${uid}:${uniqueId}`

const getPatchFavoriteVersionKey = (uid: number) =>
  `${PATCH_FAVORITE_VERSION_KEY}:${uid}`

const getPatchFavoriteCacheVersion = async (uid: number) => {
  if (uid <= 0) {
    return PATCH_FAVORITE_DEFAULT_VERSION
  }

  return (
    (await getKv(getPatchFavoriteVersionKey(uid))) ??
    PATCH_FAVORITE_DEFAULT_VERSION
  )
}

const serializePatchFavoriteStatus = (version: string, isFavorite: boolean) =>
  `${version}:${isFavorite ? '1' : '0'}`

const parsePatchFavoriteStatus = (cachedStatus: string) => {
  if (cachedStatus === '1' || cachedStatus === '0') {
    return {
      version: PATCH_FAVORITE_DEFAULT_VERSION,
      isFavorite: cachedStatus === '1'
    }
  }

  const separatorIndex = cachedStatus.lastIndexOf(':')
  if (separatorIndex === -1) {
    return null
  }

  const version = cachedStatus.slice(0, separatorIndex)
  const status = cachedStatus.slice(separatorIndex + 1)
  if (!version || (status !== '1' && status !== '0')) {
    return null
  }

  return {
    version,
    isFavorite: status === '1'
  }
}

type PatchFavoriteCacheResult = {
  isFavorite: boolean | null
  version: string
  canWrite: boolean
}

const logPatchFavoriteCacheError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

export const getCachedPatchFavoriteStatus = async (
  uniqueId: string,
  uid: number
): Promise<PatchFavoriteCacheResult> => {
  if (uid <= 0) {
    return {
      isFavorite: false,
      version: PATCH_FAVORITE_DEFAULT_VERSION,
      canWrite: false
    }
  }

  let cached: (string | null)[]

  try {
    cached = await getKvs([
      getPatchFavoriteCacheKey(uniqueId, uid),
      getPatchFavoriteVersionKey(uid)
    ])
  } catch (error) {
    // Redis 读失败降级为回源数据库: isFavorite=null 使调用方走 Prisma 查询,
    // canWrite=false 使其跳过写回 (慢 Redis 下写回会再耗一个 commandTimeout)
    logPatchFavoriteCacheError('Failed to read patch favorite cache:', error)
    return {
      isFavorite: null,
      version: PATCH_FAVORITE_DEFAULT_VERSION,
      canWrite: false
    }
  }

  const [cachedStatus, currentVersion] = cached
  const version = currentVersion ?? PATCH_FAVORITE_DEFAULT_VERSION

  if (cachedStatus === null) {
    return {
      isFavorite: null,
      version,
      canWrite: true
    }
  }

  const parsedStatus = parsePatchFavoriteStatus(cachedStatus)
  if (!parsedStatus || parsedStatus.version !== version) {
    return {
      isFavorite: null,
      version,
      canWrite: true
    }
  }

  return {
    isFavorite: parsedStatus.isFavorite,
    version,
    canWrite: true
  }
}

export const setCachedPatchFavoriteStatus = async (
  uniqueId: string,
  uid: number,
  isFavorite: boolean,
  version?: string
) => {
  if (uid <= 0) {
    return
  }

  // 写缓存失败不应使请求失败; 版本落后的写入会在下次读时被版本比对判为不匹配而回源
  try {
    const cacheVersion = version ?? (await getPatchFavoriteCacheVersion(uid))

    await setKv(
      getPatchFavoriteCacheKey(uniqueId, uid),
      serializePatchFavoriteStatus(cacheVersion, isFavorite),
      PATCH_FAVORITE_CACHE_DURATION
    )
  } catch (error) {
    logPatchFavoriteCacheError('Failed to write patch favorite cache:', error)
  }
}

const getPatchContentCacheKeys = (uniqueId: string) => [
  getPatchCacheKey(uniqueId),
  getPatchIntroductionCacheKey(uniqueId)
]

// 失败仍向上抛出: 调用方一律 best-effort 吞掉, 此处只负责把静默失败记成日志
const delPatchContentCacheKeys = async (keys: string[]) => {
  try {
    await delKvs(keys)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to invalidate patch content cache:', error)
    throw error
  }
}

// 两键走单条 DEL (键数恒为 2, 必在 delKvs 单批内, 故 Redis 单命令原子): 拆成两次
// 删除时, introduction 键失败而 patch 键成功会留下"新 summary + 旧 HTML"的不一致缓存
// (introduction 缓存内嵌渲染后 HTML, patch 缓存存 raw markdown), 且持续到 TTL 过期
export const invalidatePatchContentCache = async (uniqueId: string) => {
  await delPatchContentCacheKeys(getPatchContentCacheKeys(uniqueId))
}

// 只持有数字 patch_id 的写路径 (评分/评论统计变更) 用它失效补丁详情缓存:
// 详情缓存内嵌 ratingSummary 与 _count(评论/资源/收藏), 缓存键按 unique_id.
// 调用方须在事务提交后 best-effort 调用 (事务内失效会被并发读回填旧值, 见 M-04)
export const invalidatePatchContentCacheByPatchId = async (
  patchIds: number | number[]
) => {
  const ids = Array.isArray(patchIds) ? [...new Set(patchIds)] : [patchIds]
  if (!ids.length) {
    return
  }
  const patches = await prisma.patch.findMany({
    where: { id: { in: ids } },
    select: { unique_id: true }
  })
  await delPatchContentCacheKeys(
    patches.flatMap((patch) => getPatchContentCacheKeys(patch.unique_id))
  )
}

export const invalidatePatchFavoriteCache = async (
  uniqueId: string,
  uid: number
) => {
  if (uid <= 0) {
    return
  }

  await delKv(getPatchFavoriteCacheKey(uniqueId, uid))
}

export const invalidatePatchFavoriteCaches = async (
  uniqueIds: string[],
  uid: number
) => {
  if (uid <= 0) {
    return
  }

  const cacheKeys = [...new Set(uniqueIds)].map((uniqueId) =>
    getPatchFavoriteCacheKey(uniqueId, uid)
  )
  await delKvs(cacheKeys)
}

export const bumpPatchFavoriteCacheVersion = async (uid: number) => {
  if (uid <= 0) {
    return
  }

  await setKv(getPatchFavoriteVersionKey(uid), randomUUID())
}
