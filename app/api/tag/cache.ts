import { createHash, randomUUID } from 'crypto'
import { TAG_LIST_CACHE_DURATION } from '~/config/cache'
import { delKv, getKv, setKv } from '~/lib/redis'
import { kunLog } from '~/lib/log.server'
import type { Tag } from '~/types/api/tag'

const TAG_LIST_CACHE_KEY_PREFIX = 'tag:list'
const TAG_LIST_CACHE_VERSION_KEY = 'tag:list:version'

interface TagListCacheInput {
  page: number
  limit: number
}

export interface TagListResponse {
  tags: Tag[]
  total: number
}

const logTagListCacheError = (message: string, error: unknown) => {
  kunLog('cache.degraded', { ns: 'tag:list', op: message }, error)
}

const deleteTagListCache = async (cacheKey: string) => {
  try {
    await delKv(cacheKey)
  } catch (error) {
    logTagListCacheError('Failed to delete invalid tag list cache:', error)
  }
}

export const invalidateTagListCache = async () => {
  try {
    await setKv(TAG_LIST_CACHE_VERSION_KEY, randomUUID())
  } catch (error) {
    logTagListCacheError('Failed to invalidate tag list cache:', error)
  }
}

export const getTagListCacheKey = async (
  input: TagListCacheInput,
  blockedTagIds: readonly number[]
) => {
  let version = '0'

  try {
    version = (await getKv(TAG_LIST_CACHE_VERSION_KEY)) ?? version
  } catch (error) {
    logTagListCacheError('Failed to read tag list cache version:', error)
    return null
  }

  const normalizedBlockedTagIds = [...new Set(blockedTagIds)].sort(
    (left, right) => left - right
  )
  const parts = [
    version,
    String(input.page),
    String(input.limit),
    normalizedBlockedTagIds.join(',')
  ].join('|')
  const hash = createHash('sha1').update(parts).digest('hex').slice(0, 16)
  return `${TAG_LIST_CACHE_KEY_PREFIX}:${hash}`
}

export const getCachedTagList = async (cacheKey: string | null) => {
  if (!cacheKey) {
    return { response: null, canWrite: false }
  }

  let cached: string | null

  try {
    cached = await getKv(cacheKey)
  } catch (error) {
    logTagListCacheError('Failed to read tag list cache:', error)
    return { response: null, canWrite: false }
  }

  if (!cached) {
    return { response: null, canWrite: true }
  }

  try {
    return {
      response: JSON.parse(cached) as TagListResponse,
      canWrite: true
    }
  } catch (error) {
    logTagListCacheError('Failed to parse tag list cache:', error)
    await deleteTagListCache(cacheKey)
    return { response: null, canWrite: true }
  }
}

export const setTagListCache = async (
  cacheKey: string,
  response: TagListResponse
) => {
  try {
    await setKv(cacheKey, JSON.stringify(response), TAG_LIST_CACHE_DURATION)
  } catch (error) {
    logTagListCacheError('Failed to write tag list cache:', error)
  }
}
