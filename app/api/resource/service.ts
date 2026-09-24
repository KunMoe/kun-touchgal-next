import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { resourceSchema } from '~/validations/resource'
import {
  getCachedResourceList,
  getResourceListCacheKey,
  setResourceListCache,
  setResourceListCacheIfAbsent
} from './cache'
import {
  getResourceVisibilityWhere,
  type KunViewer
} from '~/app/api/utils/contentVisibility'
import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'
import { hasBlockedTagFilter } from '~/app/api/utils/visibilityCacheKey'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { PatchResource, ResourceListResponse } from '~/types/api/resource'

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
      orderBy: orderByField,
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
        },
        _count: {
          select: {
            like_by: true,
            links: true
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
    linkCount: resource._count.links,
    likeCount: resource._count.like_by,
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
  visibilityWhere: Prisma.patchWhereInput,
  viewer: KunViewer | null,
  bypassCache: boolean
): Promise<ResourceListResponse> => {
  // 带屏蔽标签的视角不参与共享缓存, 见 hasBlockedTagFilter
  const cacheKey =
    bypassCache || hasBlockedTagFilter(visibilityWhere)
      ? null
      : await getResourceListCacheKey(input, visibilityWhere)

  const cached = await getCachedResourceList(cacheKey)
  if (cached.response) {
    return cached.response
  }

  // 共享缓存路径按公开视角查询, 避免 viewer 相关内容写入缓存
  const statusWhere = bypassCache
    ? getResourceVisibilityWhere(viewer)
    : { status: 0 }

  // bypassCache / 版本号读取失败 (cacheKey 为 null) 与缓存读失败均不参与单飞
  if (!cacheKey || !cached.canWrite) {
    return queryPatchResource(input, visibilityWhere, statusWhere)
  }

  return kunCacheSingleflight({
    cacheKey,
    readCache: () => getCachedResourceList(cacheKey),
    writeCache: (response) => setResourceListCache(cacheKey, response),
    writeCacheIfAbsent: (response) =>
      setResourceListCacheIfAbsent(cacheKey, response),
    query: () => queryPatchResource(input, visibilityWhere, statusWhere)
  })
}
