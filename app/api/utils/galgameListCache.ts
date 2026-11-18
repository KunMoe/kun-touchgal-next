import { createHash } from 'crypto'
import { delKv, getKv, setKv, setKvIfAbsent } from '~/lib/redis'
import { GALGAME_LIST_CACHE_DURATION } from '~/config/cache'
import { kunCacheSingleflight } from './cacheSingleflight'
import type { PublicListView } from '~/server/viewer/patchVisibility'

const normalizeFilterValues = (values: string[]) => [...new Set(values)].sort()

export interface GalgameListResponse {
  galgames: GalgameCard[]
  total: number
}

interface GalgameListCacheResult {
  response: GalgameListResponse | null
  canWrite: boolean
}

interface GalgameListCacheKeyInput {
  selectedType: string
  selectedLanguage: string
  selectedPlatform: string
  sortField: string
  sortOrder: string
  page: number
  limit: number
  minRatingCount: number
}

interface WithGalgameListCacheOptions {
  cacheKeyPrefix: string
  input: GalgameListCacheKeyInput
  years: string[]
  months: string[]
  // 作品列表不含待审核内容, 没有 personal 视角
  view: PublicListView
  query: () => Promise<GalgameListResponse>
}

const logGalgameListCacheError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

const getGalgameListCacheKey = (
  {
    cacheKeyPrefix,
    input,
    years,
    months
  }: Omit<WithGalgameListCacheOptions, 'query' | 'view'>,
  cacheVariant: string
) => {
  const parts = [
    input.selectedType,
    input.selectedLanguage,
    input.selectedPlatform,
    input.sortField,
    input.sortOrder,
    String(input.page),
    String(input.limit),
    String(input.minRatingCount),
    normalizeFilterValues(years).join(','),
    normalizeFilterValues(months).join(','),
    cacheVariant
  ].join('|')
  const hash = createHash('sha1').update(parts).digest('hex').slice(0, 16)
  return `${cacheKeyPrefix}:${hash}`
}

const deleteGalgameListCache = async (cacheKey: string) => {
  try {
    await delKv(cacheKey)
  } catch (error) {
    logGalgameListCacheError(
      'Failed to delete invalid galgame list cache:',
      error
    )
  }
}

const getCachedGalgameList = async (
  cacheKey: string
): Promise<GalgameListCacheResult> => {
  let cached: string | null

  try {
    cached = await getKv(cacheKey)
  } catch (error) {
    logGalgameListCacheError('Failed to read galgame list cache:', error)
    return { response: null, canWrite: false }
  }

  if (!cached) {
    return { response: null, canWrite: true }
  }

  try {
    return {
      response: JSON.parse(cached) as GalgameListResponse,
      canWrite: true
    }
  } catch (error) {
    logGalgameListCacheError('Failed to parse galgame list cache:', error)
    await deleteGalgameListCache(cacheKey)
    return { response: null, canWrite: true }
  }
}

const setGalgameListCache = async (
  cacheKey: string,
  response: GalgameListResponse
) => {
  try {
    await setKv(cacheKey, JSON.stringify(response), GALGAME_LIST_CACHE_DURATION)
  } catch (error) {
    logGalgameListCacheError('Failed to write galgame list cache:', error)
  }
}

const setGalgameListCacheIfAbsent = async (
  cacheKey: string,
  response: GalgameListResponse
) => {
  try {
    await setKvIfAbsent(
      cacheKey,
      JSON.stringify(response),
      GALGAME_LIST_CACHE_DURATION
    )
  } catch (error) {
    logGalgameListCacheError('Failed to write galgame list cache:', error)
  }
}

export const withGalgameListCache = async (
  options: WithGalgameListCacheOptions
): Promise<GalgameListResponse> => {
  // 只有 shared 视角读写共享缓存 (各视角的含义见 ListView)
  if (options.view.kind !== 'shared') {
    return options.query()
  }

  const cacheKey = getGalgameListCacheKey(options, options.view.cacheVariant)

  const cached = await getCachedGalgameList(cacheKey)
  if (cached.response) {
    return cached.response
  }

  // 缓存读失败 (canWrite=false) 不参与单飞, 避免阻塞在锁上
  if (!cached.canWrite) {
    return options.query()
  }

  return kunCacheSingleflight({
    cacheKey,
    readCache: () => getCachedGalgameList(cacheKey),
    writeCache: (response) => setGalgameListCache(cacheKey, response),
    writeCacheIfAbsent: (response) =>
      setGalgameListCacheIfAbsent(cacheKey, response),
    query: options.query
  })
}
