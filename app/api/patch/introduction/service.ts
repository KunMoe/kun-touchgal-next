import * as z from 'zod'
import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'
import {
  PATCH_NOT_FOUND,
  buildPatchIntroduction,
  getCachedPatchIntroduction,
  setCachedPatchIntroduction,
  setCachedPatchIntroductionIfAbsent
} from '../_content'
import { getPatchIntroductionContentByUniqueId } from '../_queries'
import { getPatchIntroductionCacheKey } from '../cache'

const uniqueIdSchema = z.object({
  uniqueId: z.string().min(8).max(8)
})

export const getPatchIntroduction = async (
  input: z.infer<typeof uniqueIdSchema>
) => {
  const { uniqueId } = input

  const cached = await getCachedPatchIntroduction(uniqueId)
  if (cached.response) {
    return cached.response
  }

  const queryIntroduction = async () => {
    const patch = await getPatchIntroductionContentByUniqueId(uniqueId)
    if (!patch) {
      return PATCH_NOT_FOUND
    }
    return buildPatchIntroduction(patch)
  }

  // 锁挂在 introduction key 的独立 :intro 后缀上, 与 getPatchPageData 的 introduction-key 锁分离:
  // 后者持锁写 patch+intro 两者, 本路仅写 intro, 共锁会让 pageData 等待者因 patch 仍缺失而空耗重试梯
  // 缓存读失败 (canWrite=false) 不参与单飞, 避免阻塞在锁上
  const result = cached.canWrite
    ? await kunCacheSingleflight({
        cacheKey: `${getPatchIntroductionCacheKey(uniqueId)}:intro`,
        readCache: () => getCachedPatchIntroduction(uniqueId),
        writeCache: async (response) => {
          if (response !== PATCH_NOT_FOUND) {
            await setCachedPatchIntroduction(uniqueId, response)
          }
        },
        writeCacheIfAbsent: async (response) => {
          if (response !== PATCH_NOT_FOUND) {
            await setCachedPatchIntroductionIfAbsent(uniqueId, response)
          }
        },
        query: queryIntroduction
      })
    : await queryIntroduction()

  if (result === PATCH_NOT_FOUND) {
    return '未找到对应 Galgame'
  }

  return result
}
