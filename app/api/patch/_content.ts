import {
  PATCH_CACHE_DURATION,
  PATCH_INTRODUCTION_CACHE_DURATION
} from '~/config/cache'
import { toGalgameCardCount } from '~/constants/api/select'
import { getKv, setKv, setKvIfAbsent } from '~/lib/redis'
import { prisma } from '~/prisma/index'
import { roundOneDecimal } from '~/utils/rating/average'
import { markdownToHtmlExtend } from '~/app/api/utils/render/markdownToHtmlExtend'
import {
  getCachedPatchFavoriteStatus,
  getPatchCacheKey,
  getPatchIntroductionCacheKey,
  setCachedPatchFavoriteStatus
} from './cache'
import type {
  Patch,
  PatchIntroduction,
  PatchRatingSummary
} from '~/types/api/patch'
import type {
  getPatchIntroductionContentByUniqueId,
  getPatchPageContentByUniqueId,
  getPatchSummaryByUniqueId
} from './_queries'

export type CachedPatch = Omit<Patch, 'isFavorite'>

// 单飞回源中表示"未找到对应 Galgame"的哨兵, 该结果不写入缓存
export const PATCH_NOT_FOUND = Symbol('kun-patch-not-found')

type PatchSummaryContent = NonNullable<
  Awaited<ReturnType<typeof getPatchSummaryByUniqueId>>
>
type PatchPageContent = NonNullable<
  Awaited<ReturnType<typeof getPatchPageContentByUniqueId>>
>
type PatchIntroductionContent = NonNullable<
  Awaited<ReturnType<typeof getPatchIntroductionContentByUniqueId>>
>
type CachedPatchSource = PatchSummaryContent | PatchPageContent
type PatchIntroductionSource = PatchIntroductionContent | PatchPageContent

const getEmptyRatingSummary = (): PatchRatingSummary => ({
  average: 0,
  count: 0,
  histogram: Array.from({ length: 10 }, (_, i) => ({
    score: i + 1,
    count: 0
  })),
  recommend: {
    strong_no: 0,
    no: 0,
    neutral: 0,
    yes: 0,
    strong_yes: 0
  }
})

const buildRatingSummary = (
  stat: CachedPatchSource['rating_stat']
): PatchRatingSummary => {
  if (!stat) {
    return getEmptyRatingSummary()
  }

  return {
    average: roundOneDecimal(stat.avg_overall),
    count: stat.count,
    histogram: [
      { score: 1, count: stat.o1 },
      { score: 2, count: stat.o2 },
      { score: 3, count: stat.o3 },
      { score: 4, count: stat.o4 },
      { score: 5, count: stat.o5 },
      { score: 6, count: stat.o6 },
      { score: 7, count: stat.o7 },
      { score: 8, count: stat.o8 },
      { score: 9, count: stat.o9 },
      { score: 10, count: stat.o10 }
    ],
    recommend: {
      strong_no: stat.rec_strong_no,
      no: stat.rec_no,
      neutral: stat.rec_neutral,
      yes: stat.rec_yes,
      strong_yes: stat.rec_strong_yes
    }
  }
}

export const buildCachedPatch = (patch: CachedPatchSource): CachedPatch => ({
  id: patch.id,
  uniqueId: patch.unique_id,
  vndbId: patch.vndb_id,
  vndbRelationId: patch.vndb_relation_id,
  bangumiId: patch.bangumi_id,
  steamId: patch.steam_id,
  dlsiteCode: patch.dlsite_code,
  name: patch.name,
  introduction: patch.introduction,
  banner: patch.banner,
  status: patch.status,
  view: patch.view,
  download: patch.download,
  type: patch.type,
  language: patch.language,
  platform: patch.platform,
  tags: patch.tag.map((t) => t.tag.name),
  alias: patch.alias.map((a) => a.name),
  contentLimit: patch.content_limit,
  ratingSummary: buildRatingSummary(patch.rating_stat),
  user: {
    id: patch.user.id,
    name: patch.user.name,
    avatar: patch.user.avatar
  },
  created: String(patch.created),
  updated: String(patch.updated),
  // 读触发器维护的计数列 (migration/ensurePatchCounters.ts); 关系 _count 会被
  // Prisma 编译成子表整表 GROUP BY, 每次未命中多耗 ~75ms
  _count: toGalgameCardCount(patch)
})

export const buildPatchIntroduction = async (
  patch: PatchIntroductionSource
): Promise<PatchIntroduction> => ({
  vndbId: patch.vndb_id,
  vndbRelationId: patch.vndb_relation_id,
  bangumiId: patch.bangumi_id,
  steamId: patch.steam_id,
  dlsiteCode: patch.dlsite_code,
  introduction: await markdownToHtmlExtend(patch.introduction),
  released: patch.released,
  alias: patch.alias.map((a) => a.name),
  tag: patch.tag.map((tag) => tag.tag),
  company: patch.company.map((company) => company.company),
  created: patch.created,
  updated: patch.updated,
  resourceUpdateTime: patch.resource_update_time
})

// Redis 读失败时降级为直连数据库 (canWrite=false 表示本次不参与单飞、不写缓存),
// canWrite 语义取自 galgameListCache / comment cache / resource detail cache。
// 刻意不设它们的 parse 失败分支: SET 是原子的不会留半个值, 且键前缀无碰撞
// (patch:<8 字符> vs patch:favorite: / patch:comment: / patch:resource:detail:),
// 旧序列化格式仍是合法 JSON, 该分支不可达
export interface PatchContentCacheResult<T> {
  response: T | null
  canWrite: boolean
}

const logPatchContentCacheError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

export const getCachedPatchContent = async (
  uniqueId: string
): Promise<PatchContentCacheResult<CachedPatch>> => {
  let cached: string | null

  try {
    cached = await getKv(getPatchCacheKey(uniqueId))
  } catch (error) {
    logPatchContentCacheError('Failed to read patch content cache:', error)
    return { response: null, canWrite: false }
  }

  return {
    response: cached ? (JSON.parse(cached) as CachedPatch) : null,
    canWrite: true
  }
}

export const getCachedPatchIntroduction = async (
  uniqueId: string
): Promise<PatchContentCacheResult<PatchIntroduction>> => {
  let cached: string | null

  try {
    cached = await getKv(getPatchIntroductionCacheKey(uniqueId))
  } catch (error) {
    logPatchContentCacheError('Failed to read patch introduction cache:', error)
    return { response: null, canWrite: false }
  }

  return {
    response: cached ? (JSON.parse(cached) as PatchIntroduction) : null,
    canWrite: true
  }
}

export const setCachedPatchContent = async (
  uniqueId: string,
  patch: CachedPatch
) => {
  await setKv(
    getPatchCacheKey(uniqueId),
    JSON.stringify(patch),
    PATCH_CACHE_DURATION
  )
}

export const setCachedPatchIntroduction = async (
  uniqueId: string,
  intro: PatchIntroduction
) => {
  await setKv(
    getPatchIntroductionCacheKey(uniqueId),
    JSON.stringify(intro),
    PATCH_INTRODUCTION_CACHE_DURATION
  )
}

export const setCachedPatchContentIfAbsent = async (
  uniqueId: string,
  patch: CachedPatch
) => {
  await setKvIfAbsent(
    getPatchCacheKey(uniqueId),
    JSON.stringify(patch),
    PATCH_CACHE_DURATION
  )
}

export const setCachedPatchIntroductionIfAbsent = async (
  uniqueId: string,
  intro: PatchIntroduction
) => {
  await setKvIfAbsent(
    getPatchIntroductionCacheKey(uniqueId),
    JSON.stringify(intro),
    PATCH_INTRODUCTION_CACHE_DURATION
  )
}

export const getPatchFavoriteStatus = async (
  uniqueId: string,
  patchId: number,
  uid: number
) => {
  if (uid <= 0) {
    return false
  }

  const cachedFavoriteStatus = await getCachedPatchFavoriteStatus(uniqueId, uid)
  if (cachedFavoriteStatus.isFavorite !== null) {
    return cachedFavoriteStatus.isFavorite
  }

  const relation = await prisma.user_patch_favorite_folder_relation.findFirst({
    where: {
      patch_id: patchId,
      folder: {
        user_id: uid
      }
    },
    select: {
      id: true
    }
  })

  const isFavorite = Boolean(relation)
  if (cachedFavoriteStatus.canWrite) {
    await setCachedPatchFavoriteStatus(
      uniqueId,
      uid,
      isFavorite,
      cachedFavoriteStatus.version
    )
  }

  return isFavorite
}

export const withPatchFavoriteStatus = async (
  uniqueId: string,
  patch: CachedPatch,
  uid: number
): Promise<Patch> => ({
  ...patch,
  isFavorite: await getPatchFavoriteStatus(uniqueId, patch.id, uid)
})
