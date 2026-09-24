import * as z from 'zod'
import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'
import {
  PATCH_NOT_FOUND,
  buildCachedPatch,
  getCachedPatchContent,
  setCachedPatchContent,
  setCachedPatchContentIfAbsent,
  withPatchFavoriteStatus
} from './_content'
import { getPatchSummaryByUniqueId } from './_queries'
import { getPatchCacheKey } from './cache'
import type { KunViewer } from '~/app/api/utils/contentVisibility'

const uniqueIdSchema = z.object({
  uniqueId: z.string().min(8).max(8)
})

export const getPatchById = async (
  input: z.infer<typeof uniqueIdSchema>,
  viewer: KunViewer | null
) => {
  const uid = viewer?.uid ?? 0
  const { uniqueId } = input
  const cached = await getCachedPatchContent(uniqueId)
  if (cached.response) {
    return withPatchFavoriteStatus(uniqueId, cached.response, uid)
  }

  const queryPatchSummary = async () => {
    const summary = await getPatchSummaryByUniqueId(uniqueId)
    return summary ? buildCachedPatch(summary) : PATCH_NOT_FOUND
  }

  // 缓存读失败 (canWrite=false) 不参与单飞, 避免阻塞在锁上
  const patch = cached.canWrite
    ? await kunCacheSingleflight({
        cacheKey: getPatchCacheKey(uniqueId),
        readCache: () => getCachedPatchContent(uniqueId),
        writeCache: async (response) => {
          if (response !== PATCH_NOT_FOUND) {
            await setCachedPatchContent(uniqueId, response)
          }
        },
        writeCacheIfAbsent: async (response) => {
          if (response !== PATCH_NOT_FOUND) {
            await setCachedPatchContentIfAbsent(uniqueId, response)
          }
        },
        query: queryPatchSummary
      })
    : await queryPatchSummary()

  if (patch === PATCH_NOT_FOUND) {
    return '未找到对应 Galgame'
  }

  return withPatchFavoriteStatus(uniqueId, patch, uid)
}
