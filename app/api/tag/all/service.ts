import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { getTagSchema } from '~/validations/tag'
import { getCachedTagList, getTagListCacheKey, setTagListCache } from '../cache'
import type { PatchVisibility } from '~/server/viewer/patchVisibility'

export const getTag = async (
  input: z.infer<typeof getTagSchema>,
  visibility: PatchVisibility
) => {
  const { page, limit } = input
  const { blockedTagIds } = visibility
  // 带屏蔽标签的视角不参与共享缓存: 屏蔽标签取自客户端的镜像 cookie, 进了键就由客户端决定键的数量
  const cacheKey =
    blockedTagIds.length > 0
      ? null
      : await getTagListCacheKey(input, blockedTagIds)
  const cached = await getCachedTagList(cacheKey)
  if (cached.response) {
    return cached.response
  }

  const offset = (page - 1) * limit
  const where = blockedTagIds.length
    ? { id: { notIn: [...blockedTagIds] } }
    : undefined

  const [data, total] = await Promise.all([
    prisma.patch_tag.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { count: 'desc' },
      select: {
        id: true,
        name: true,
        count: true,
        alias: true
      }
    }),
    prisma.patch_tag.count({ where })
  ])

  const response = { tags: data, total }
  if (cacheKey && cached.canWrite) {
    await setTagListCache(cacheKey, response)
  }

  return response
}
