import * as z from 'zod'
import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'
import {
  PATCH_NOT_FOUND,
  buildCachedPatch,
  buildPatchIntroduction,
  getCachedPatchContent,
  getCachedPatchIntroduction,
  setCachedPatchContent,
  setCachedPatchContentIfAbsent,
  setCachedPatchIntroduction,
  setCachedPatchIntroductionIfAbsent,
  withPatchFavoriteStatus
} from './_content'
import { getPatchPageContentByUniqueId } from './_queries'
import { getPatchIntroductionCacheKey } from './cache'
import type { CachedPatch } from './_content'
import type { PatchIntroduction } from '~/types/api/patch'
import type { KunViewer } from '~/app/api/utils/contentVisibility'

const uniqueIdSchema = z.object({
  uniqueId: z.string().min(8).max(8)
})

interface PatchPageCachePayload {
  patch: CachedPatch
  intro: PatchIntroduction
}

interface PatchPageCacheResult {
  response: PatchPageCachePayload | null
  canWrite: boolean
}

const readPatchPageCache = async (
  uniqueId: string
): Promise<PatchPageCacheResult> => {
  const [cachedPatch, cachedIntro] = await Promise.all([
    getCachedPatchContent(uniqueId),
    getCachedPatchIntroduction(uniqueId)
  ])
  return {
    response:
      cachedPatch.response && cachedIntro.response
        ? { patch: cachedPatch.response, intro: cachedIntro.response }
        : null,
    canWrite: cachedPatch.canWrite && cachedIntro.canWrite
  }
}

const writePatchPageCache = async (
  uniqueId: string,
  payload: PatchPageCachePayload
) => {
  await Promise.all([
    setCachedPatchContent(uniqueId, payload.patch),
    setCachedPatchIntroduction(uniqueId, payload.intro)
  ])
}

const writePatchPageCacheIfAbsent = async (
  uniqueId: string,
  payload: PatchPageCachePayload
) => {
  await Promise.all([
    setCachedPatchContentIfAbsent(uniqueId, payload.patch),
    setCachedPatchIntroductionIfAbsent(uniqueId, payload.intro)
  ])
}

export const getPatchPageData = async (
  input: z.infer<typeof uniqueIdSchema>,
  viewer: KunViewer | null
) => {
  const uid = viewer?.uid ?? 0
  const { uniqueId } = input
  const cached = await readPatchPageCache(uniqueId)
  if (cached.response) {
    return {
      patch: await withPatchFavoriteStatus(
        uniqueId,
        cached.response.patch,
        uid
      ),
      intro: cached.response.intro
    }
  }

  const queryPatchPage = async () => {
    const patchContent = await getPatchPageContentByUniqueId(uniqueId)
    if (!patchContent) {
      return PATCH_NOT_FOUND
    }

    return {
      patch: buildCachedPatch(patchContent),
      intro: await buildPatchIntroduction(patchContent)
    }
  }

  // 锁挂在 introduction key 上, 与 get.ts 的 patch key 锁分离,
  // 避免 get.ts 持锁者只写 patch 缓存时本路等待者空耗完整重试梯
  // 缓存读失败 (canWrite=false) 不参与单飞, 避免阻塞在锁上
  const result = cached.canWrite
    ? await kunCacheSingleflight({
        cacheKey: getPatchIntroductionCacheKey(uniqueId),
        readCache: () => readPatchPageCache(uniqueId),
        writeCache: async (response) => {
          if (response !== PATCH_NOT_FOUND) {
            await writePatchPageCache(uniqueId, response)
          }
        },
        writeCacheIfAbsent: async (response) => {
          if (response !== PATCH_NOT_FOUND) {
            await writePatchPageCacheIfAbsent(uniqueId, response)
          }
        },
        query: queryPatchPage
      })
    : await queryPatchPage()

  if (result === PATCH_NOT_FOUND) {
    return '未找到对应 Galgame'
  }

  return {
    patch: await withPatchFavoriteStatus(uniqueId, result.patch, uid),
    intro: result.intro
  }
}
