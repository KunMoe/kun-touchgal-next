import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { resourceSchema } from '~/validations/resource'
import {
  getCachedResourceList,
  getResourceListCacheKey,
  setResourceListCache,
  setResourceListCacheIfAbsent
} from './cache'
import { getListResourceStatusWhere } from '~/app/api/utils/contentVisibility'
import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'
import { kunRecordCacheOutcome } from '~/server/cache/stats'
import {
  toCacheVariant,
  toPatchWhere,
  type ListView
} from '~/server/viewer/patchVisibility'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { PatchResource, ResourceListResponse } from '~/types/api/resource'
import type { KunCacheNamespace, KunCacheOutcome } from '~/server/cache/stats'

const queryPatchResource = async (
  input: z.infer<typeof resourceSchema>,
  visibilityWhere: Prisma.patchWhereInput,
  statusWhere: Prisma.patch_resourceWhereInput
): Promise<ResourceListResponse> => {
  const { sortField, sortOrder, page, limit } = input

  const offset = (page - 1) * limit

  const orderByField: Prisma.patch_resourceOrderByWithRelationInput =
    sortField === 'like'
      ? { like_by: { _count: sortOrder } }
      : { [sortField]: sortOrder }

  const [resourcesData, total] = await Promise.all([
    prisma.patch_resource.findMany({
      take: limit,
      skip: offset,
      // 点赞 / 下载数大量并列, 无 id 兜底时并列项顺序随执行计划漂移, 翻页会重复或漏项
      orderBy: [orderByField, { id: sortOrder }],
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
      }
    }),
    prisma.patch_resource.count({
      where: { patch: visibilityWhere, section: 'patch', ...statusWhere }
    })
  ])

  const resources: PatchResource[] = resourcesData.map((resource) => ({
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

  return { resources, total }
}

export const getPatchResource = async (
  input: z.infer<typeof resourceSchema>,
  view: ListView
): Promise<ResourceListResponse> => {
  const visibilityWhere = toPatchWhere(view.visibility)
  const statusWhere = getListResourceStatusWhere(view)

  // 键带全站 stats 版本的两种排序单独记, 供决定它们是否改用纯 TTL
  const ns: KunCacheNamespace =
    input.sortField === 'download' || input.sortField === 'like'
      ? 'resource:list:stats'
      : 'resource:list'
  const startedAt = performance.now()
  let sourceMs: number | undefined
  const query = async () => {
    const queryStartedAt = performance.now()
    const response = await queryPatchResource(
      input,
      visibilityWhere,
      statusWhere
    )
    sourceMs = performance.now() - queryStartedAt
    return response
  }
  const done = (response: ResourceListResponse, outcome: KunCacheOutcome) => {
    kunRecordCacheOutcome(ns, outcome, performance.now() - startedAt, sourceMs)
    return response
  }

  // 只有 shared 视角读写共享缓存 (各视角的含义见 ListView), 其余视角按设计直读
  if (view.kind !== 'shared') {
    return done(await query(), 'direct')
  }

  const cacheKey = await getResourceListCacheKey(input, toCacheVariant(view))
  const cached = await getCachedResourceList(cacheKey)
  if (cached.response) {
    return done(cached.response, 'hit')
  }

  // 版本号读取失败 (cacheKey 为 null) 与缓存读失败均不参与单飞
  if (!cacheKey || !cached.canWrite) {
    return done(await query(), 'degraded')
  }

  const response = await kunCacheSingleflight({
    cacheKey,
    readCache: () => getCachedResourceList(cacheKey),
    writeCache: (response) => setResourceListCache(cacheKey, response),
    writeCacheIfAbsent: (response) =>
      setResourceListCacheIfAbsent(cacheKey, response),
    query
  })
  return done(response, sourceMs === undefined ? 'wait' : 'miss')
}
