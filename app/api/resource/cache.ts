import { createHash, randomUUID } from 'crypto'
import * as z from 'zod'
import { RESOURCE_LIST_CACHE_DURATION } from '~/config/cache'
import { delKv, getKv, getKvs, setKv, setKvIfAbsent } from '~/lib/redis'
import { resourceSchema } from '~/validations/resource'
import { buildVisibilityCacheKey } from '~/app/api/utils/visibilityCacheKey'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { ResourceListResponse } from '~/types/api/resource'

const RESOURCE_LIST_CACHE_KEY_PREFIX = 'resource:list'
// 仅列表缓存自用: patch 详情缓存的版本键已按 patch 分片, 不再复用这两个全局键
const RESOURCE_LIST_CACHE_CONTENT_VERSION_KEY = 'resource:list:version:content'
const RESOURCE_LIST_CACHE_STATS_VERSION_KEY = 'resource:list:version:stats'

const logResourceListCacheError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

const deleteResourceListCache = async (cacheKey: string) => {
  try {
    await delKv(cacheKey)
  } catch (error) {
    logResourceListCacheError(
      'Failed to delete invalid resource list cache:',
      error
    )
  }
}

export const invalidateResourceListCache = async () => {
  try {
    await setKv(RESOURCE_LIST_CACHE_CONTENT_VERSION_KEY, randomUUID())
  } catch (error) {
    logResourceListCacheError(
      'Failed to invalidate resource list cache:',
      error
    )
  }
}

export const invalidateResourceStatsListCache = async () => {
  try {
    await setKv(RESOURCE_LIST_CACHE_STATS_VERSION_KEY, randomUUID())
  } catch (error) {
    logResourceListCacheError(
      'Failed to invalidate resource stats list cache:',
      error
    )
  }
}

export const getResourceListCacheKey = async (
  input: z.infer<typeof resourceSchema>,
  visibilityWhere: Prisma.patchWhereInput
) => {
  const shouldUseStatsVersion =
    input.sortField === 'download' || input.sortField === 'like'
  const versionKeys = shouldUseStatsVersion
    ? [
        RESOURCE_LIST_CACHE_CONTENT_VERSION_KEY,
        RESOURCE_LIST_CACHE_STATS_VERSION_KEY
      ]
    : [RESOURCE_LIST_CACHE_CONTENT_VERSION_KEY]
  let contentVersion = '0'
  let statsVersion = '0'

  try {
    const versions = await getKvs(versionKeys)
    contentVersion = versions[0] ?? contentVersion
    statsVersion = versions[1] ?? statsVersion
  } catch (error) {
    logResourceListCacheError(
      'Failed to read resource list cache version:',
      error
    )
    return null
  }

  const parts = [
    contentVersion,
    statsVersion,
    input.sortField,
    input.sortOrder,
    String(input.page),
    String(input.limit),
    buildVisibilityCacheKey(visibilityWhere)
  ].join('|')
  const hash = createHash('sha1').update(parts).digest('hex').slice(0, 16)
  return `${RESOURCE_LIST_CACHE_KEY_PREFIX}:${hash}`
}

export const getCachedResourceList = async (cacheKey: string | null) => {
  if (!cacheKey) {
    return { response: null, canWrite: false }
  }

  let cached: string | null

  try {
    cached = await getKv(cacheKey)
  } catch (error) {
    logResourceListCacheError('Failed to read resource list cache:', error)
    return { response: null, canWrite: false }
  }

  if (!cached) {
    return { response: null, canWrite: true }
  }

  try {
    return {
      response: JSON.parse(cached) as ResourceListResponse,
      canWrite: true
    }
  } catch (error) {
    logResourceListCacheError('Failed to parse resource list cache:', error)
    await deleteResourceListCache(cacheKey)
    return { response: null, canWrite: true }
  }
}

export const setResourceListCache = async (
  cacheKey: string,
  response: ResourceListResponse
) => {
  try {
    await setKv(
      cacheKey,
      JSON.stringify(response),
      RESOURCE_LIST_CACHE_DURATION
    )
  } catch (error) {
    logResourceListCacheError('Failed to write resource list cache:', error)
  }
}

export const setResourceListCacheIfAbsent = async (
  cacheKey: string,
  response: ResourceListResponse
) => {
  try {
    await setKvIfAbsent(
      cacheKey,
      JSON.stringify(response),
      RESOURCE_LIST_CACHE_DURATION
    )
  } catch (error) {
    logResourceListCacheError('Failed to write resource list cache:', error)
  }
}
