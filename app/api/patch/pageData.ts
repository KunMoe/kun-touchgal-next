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
import { kunRecordCacheOutcome } from '~/server/cache/stats'
import type { CachedPatch } from './_content'
import type { KunCacheOutcome } from '~/server/cache/stats'
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

const queryPatchPage = async (
  uniqueId: string
): Promise<PatchPageCachePayload | typeof PATCH_NOT_FOUND> => {
  const patchContent = await getPatchPageContentByUniqueId(uniqueId)
  if (!patchContent) {
    return PATCH_NOT_FOUND
  }

  return {
    patch: buildCachedPatch(patchContent),
    intro: await buildPatchIntroduction(patchContent)
  }
}

// 不含收藏状态: 它是另一个命名空间 (patch:favorite), 两种读法都要查
const loadPatchPage = async (uniqueId: string) => {
  const startedAt = performance.now()
  // 只在本请求自己回源时有值, 单飞返回时仍为空即结果来自别人写的缓存 (wait)
  let sourceMs: number | undefined
  const query = async () => {
    const queryStartedAt = performance.now()
    const result = await queryPatchPage(uniqueId)
    sourceMs = performance.now() - queryStartedAt
    return result
  }
  const done = (
    result: PatchPageCachePayload | typeof PATCH_NOT_FOUND,
    outcome: KunCacheOutcome
  ) => {
    kunRecordCacheOutcome(
      'patch:page',
      result === PATCH_NOT_FOUND ? 'notFound' : outcome,
      performance.now() - startedAt,
      sourceMs
    )
    return result
  }

  const cached = await readPatchPageCache(uniqueId)
  if (cached.response) {
    return done(cached.response, 'hit')
  }

  // 缓存读失败 (canWrite=false) 不参与单飞, 避免阻塞在锁上
  if (!cached.canWrite) {
    return done(await query(), 'degraded')
  }

  // 锁挂在 introduction key 上, 与 get.ts 的 patch key 锁分离,
  // 避免 get.ts 持锁者只写 patch 缓存时本路等待者空耗完整重试梯
  const result = await kunCacheSingleflight({
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
    query
  })
  return done(result, sourceMs === undefined ? 'wait' : 'miss')
}

// 作品不存在时返回 null: 文案与 404 由调用方决定 (页面读取器调 notFound)
export const getPatchPageData = async (
  input: z.infer<typeof uniqueIdSchema>,
  viewer: KunViewer | null
) => {
  const uid = viewer?.uid ?? 0
  const { uniqueId } = input
  const result = await loadPatchPage(uniqueId)
  if (result === PATCH_NOT_FOUND) {
    return null
  }

  return {
    patch: await withPatchFavoriteStatus(uniqueId, result.patch, uid),
    intro: result.intro
  }
}
