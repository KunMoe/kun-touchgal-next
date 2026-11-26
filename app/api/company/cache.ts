import { createHash, randomUUID } from 'crypto'
import { COMPANY_LIST_CACHE_DURATION } from '~/config/cache'
import { delKv, getKv, setKv } from '~/lib/redis'
import { kunLog } from '~/lib/log.server'
import type { Company } from '~/types/api/company'

const COMPANY_LIST_CACHE_KEY_PREFIX = 'company:list'
const COMPANY_LIST_CACHE_VERSION_KEY = 'company:list:version'

interface CompanyListCacheInput {
  page: number
  limit: number
}

export interface CompanyListResponse {
  companies: Company[]
  total: number
}

const logCompanyListCacheError = (message: string, error: unknown) => {
  kunLog('cache.degraded', { ns: 'company:list', op: message }, error)
}

const deleteCompanyListCache = async (cacheKey: string) => {
  try {
    await delKv(cacheKey)
  } catch (error) {
    logCompanyListCacheError(
      'Failed to delete invalid company list cache:',
      error
    )
  }
}

export const invalidateCompanyListCache = async () => {
  try {
    await setKv(COMPANY_LIST_CACHE_VERSION_KEY, randomUUID())
  } catch (error) {
    logCompanyListCacheError('Failed to invalidate company list cache:', error)
  }
}

export const getCompanyListCacheKey = async (input: CompanyListCacheInput) => {
  let version = '0'

  try {
    version = (await getKv(COMPANY_LIST_CACHE_VERSION_KEY)) ?? version
  } catch (error) {
    logCompanyListCacheError(
      'Failed to read company list cache version:',
      error
    )
    return null
  }

  const parts = [version, String(input.page), String(input.limit)].join('|')
  const hash = createHash('sha1').update(parts).digest('hex').slice(0, 16)
  return `${COMPANY_LIST_CACHE_KEY_PREFIX}:${hash}`
}

export const getCachedCompanyList = async (cacheKey: string | null) => {
  if (!cacheKey) {
    return { response: null, canWrite: false }
  }

  let cached: string | null

  try {
    cached = await getKv(cacheKey)
  } catch (error) {
    logCompanyListCacheError('Failed to read company list cache:', error)
    return { response: null, canWrite: false }
  }

  if (!cached) {
    return { response: null, canWrite: true }
  }

  try {
    return {
      response: JSON.parse(cached) as CompanyListResponse,
      canWrite: true
    }
  } catch (error) {
    logCompanyListCacheError('Failed to parse company list cache:', error)
    await deleteCompanyListCache(cacheKey)
    return { response: null, canWrite: true }
  }
}

export const setCompanyListCache = async (
  cacheKey: string,
  response: CompanyListResponse
) => {
  try {
    await setKv(cacheKey, JSON.stringify(response), COMPANY_LIST_CACHE_DURATION)
  } catch (error) {
    logCompanyListCacheError('Failed to write company list cache:', error)
  }
}
