import { createHash } from 'crypto'
import { prisma } from '~/prisma/index'
import { delKv, getKv, setKv, setKvIfAbsent } from '~/lib/redis'
import { HOME_CACHE_DURATION } from '~/config/cache'
import { GalgameCardSelectField, toGalgameCard } from '~/constants/api/select'
import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'
import { getListResourceStatusWhere } from '~/app/api/utils/contentVisibility'
import { toPatchWhere, type ListView } from '~/server/viewer/patchVisibility'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { HomeResource } from '~/types/api/home'

const HOME_CACHE_KEY_PREFIX = 'home:v2'

// 与 galgame / resource 列表缓存一致: 键里的视角段取哈希
const getHomeCacheKey = (cacheVariant: string) => {
  const hash = createHash('sha1')
    .update(cacheVariant)
    .digest('hex')
    .slice(0, 16)
  return `${HOME_CACHE_KEY_PREFIX}:${hash}`
}

interface HomeResponse {
  galgames: GalgameCard[]
  resources: HomeResource[]
}

interface HomeCacheResult {
  response: HomeResponse | null
  canWrite: boolean
}

const logHomeCacheError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

const deleteHomeCache = async (cacheKey: string) => {
  try {
    await delKv(cacheKey)
  } catch (error) {
    logHomeCacheError('Failed to delete invalid home cache:', error)
  }
}

const getCachedHomeData = async (
  cacheKey: string
): Promise<HomeCacheResult> => {
  let cached: string | null

  try {
    cached = await getKv(cacheKey)
  } catch (error) {
    logHomeCacheError('Failed to read home cache:', error)
    return { response: null, canWrite: false }
  }

  if (!cached) {
    return { response: null, canWrite: true }
  }

  try {
    return { response: JSON.parse(cached) as HomeResponse, canWrite: true }
  } catch (error) {
    logHomeCacheError('Failed to parse home cache:', error)
    await deleteHomeCache(cacheKey)
    return { response: null, canWrite: true }
  }
}

const setHomeCache = async (cacheKey: string, response: HomeResponse) => {
  try {
    await setKv(cacheKey, JSON.stringify(response), HOME_CACHE_DURATION)
  } catch (error) {
    logHomeCacheError('Failed to write home cache:', error)
  }
}

const queryHomeData = async (
  visibilityWhere: Prisma.patchWhereInput,
  statusWhere: Prisma.patch_resourceWhereInput
): Promise<HomeResponse> => {
  const [data, resourcesData] = await Promise.all([
    prisma.patch.findMany({
      orderBy: { created: 'desc' },
      where: visibilityWhere,
      select: GalgameCardSelectField,
      take: 24
    }),
    prisma.patch_resource.findMany({
      orderBy: { created: 'desc' },
      where: { patch: visibilityWhere, section: 'patch', ...statusWhere },
      select: {
        id: true,
        name: true,
        section: true,
        type: true,
        language: true,
        platform: true,
        emulator_type: true,
        model_name: true,
        download: true,
        patch_id: true,
        created: true,
        patch: {
          select: {
            name: true,
            unique_id: true
          }
        },
        user: {
          select: {
            id: true,
            name: true,
            avatar: true,
            role: true,
            _count: {
              select: { patch_resource: true }
            }
          }
        },
        links: {
          orderBy: { sort_order: 'asc' },
          take: 1,
          select: {
            size: true
          }
        }
      },
      take: 6
    })
  ])

  const galgames: GalgameCard[] = data.map(toGalgameCard)

  const resources: HomeResource[] = resourcesData.map((resource) => ({
    id: resource.id,
    name: resource.name,
    section: resource.section,
    uniqueId: resource.patch.unique_id,
    type: resource.type,
    language: resource.language,
    platform: resource.platform,
    emulatorType: resource.emulator_type,
    modelName: resource.model_name,
    primaryLink: resource.links[0] ? { size: resource.links[0].size } : null,
    download: resource.download,
    patchId: resource.patch_id,
    patchName: resource.patch.name,
    created: String(resource.created),
    user: {
      id: resource.user.id,
      name: resource.user.name,
      avatar: resource.user.avatar,
      patchCount: resource.user._count.patch_resource,
      role: resource.user.role
    }
  }))

  return { galgames, resources }
}

const setHomeCacheIfAbsent = async (
  cacheKey: string,
  response: HomeResponse
) => {
  try {
    await setKvIfAbsent(cacheKey, JSON.stringify(response), HOME_CACHE_DURATION)
  } catch (error) {
    logHomeCacheError('Failed to write home cache:', error)
  }
}

export const getHomeData = async (view: ListView): Promise<HomeResponse> => {
  const visibilityWhere = toPatchWhere(view.visibility)
  const statusWhere = getListResourceStatusWhere(view)

  // 只有 shared 视角读写共享缓存 (各视角的含义见 ListView)
  if (view.kind !== 'shared') {
    return queryHomeData(visibilityWhere, statusWhere)
  }

  const cacheKey = getHomeCacheKey(view.cacheVariant)
  const cached = await getCachedHomeData(cacheKey)
  if (cached.response) {
    return cached.response
  }

  if (!cached.canWrite) {
    return queryHomeData(visibilityWhere, statusWhere)
  }

  return kunCacheSingleflight({
    cacheKey,
    readCache: () => getCachedHomeData(cacheKey),
    writeCache: (response) => setHomeCache(cacheKey, response),
    writeCacheIfAbsent: (response) => setHomeCacheIfAbsent(cacheKey, response),
    query: () => queryHomeData(visibilityWhere, statusWhere)
  })
}
