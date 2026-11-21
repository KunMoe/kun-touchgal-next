import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { getPatchByTagSchema } from '~/validations/tag'
import { GalgameCardSelectField, toGalgameCard } from '~/constants/api/select'
import {
  buildGalgameDateFilter,
  buildGalgameOrderBy,
  buildGalgameWhere
} from '~/app/api/utils/galgameQuery'
import { withGalgameListCache } from '~/app/api/utils/galgameListCache'
import { parseGalgameFilterArray } from '~/utils/galgameFilter'
import {
  buildGalgameSearchFilter,
  buildGalgameSearchSort
} from '~/server/search/filter-builder'
import { queryGalgameIds } from '~/server/search/query'
import { MeiliBadRequestError, withMeiliEngine } from '~/server/search/failure'
import { fetchGalgameCardsByIds } from '~/server/galgame/cards'
import {
  toPatchWhere,
  toSearchVisibility,
  type PatchVisibility,
  type PublicListView
} from '~/server/viewer/patchVisibility'
import type { Prisma } from '~/prisma/generated/prisma/client'

// 索引只给这一页的 id 与总数, 卡片由 queryPatchByTag 回 PG 取
const getPatchIdsByTagFromSearch = async (
  input: z.infer<typeof getPatchByTagSchema>,
  years: string[],
  months: string[],
  visibility: PatchVisibility
) => {
  const filter = buildGalgameSearchFilter({
    selectedType: input.selectedType,
    selectedLanguage: input.selectedLanguage,
    selectedPlatform: input.selectedPlatform,
    years,
    months,
    minRatingCount: input.sortField === 'rating' ? input.minRatingCount : 0,
    ...toSearchVisibility(visibility),
    tagId: input.tagId
  })
  if (filter === null) {
    return { ids: [], total: 0 }
  }

  return queryGalgameIds({
    q: '',
    filter,
    sort: buildGalgameSearchSort(input.sortField, input.sortOrder),
    page: input.page,
    hitsPerPage: input.limit
  })
}

// basic 引擎 (PG): Meilisearch 未启用时的唯一实现, 启用时是它出故障后的降级, 勿删
const legacyGetPatchByTag = async (
  input: z.infer<typeof getPatchByTagSchema>,
  years: string[],
  months: string[],
  visibilityWhere: Prisma.patchWhereInput
) => {
  const {
    tagId,
    page,
    limit,
    sortField,
    sortOrder,
    selectedType,
    selectedLanguage,
    selectedPlatform,
    minRatingCount
  } = input
  const offset = (page - 1) * limit
  const orderBy = buildGalgameOrderBy(sortField, sortOrder).map((patch) => ({
    patch
  }))
  const patchWhere = {
    ...buildGalgameDateFilter(years, months),
    ...buildGalgameWhere({
      selectedType,
      selectedLanguage,
      selectedPlatform,
      minRatingCount: sortField === 'rating' ? minRatingCount : 0,
      visibilityWhere
    })
  }

  const [data, total] = await Promise.all([
    prisma.patch_tag_relation.findMany({
      where: { tag_id: tagId, patch: patchWhere },
      select: {
        patch: {
          select: GalgameCardSelectField
        }
      },
      orderBy,
      take: limit,
      skip: offset
    }),
    prisma.patch_tag_relation.count({
      where: { tag_id: tagId, patch: patchWhere }
    })
  ])

  const patches = data.map((p) => p.patch)
  const galgames: GalgameCard[] = patches.map(toGalgameCard)

  return { galgames, total }
}

const queryPatchByTag = async (
  input: z.infer<typeof getPatchByTagSchema>,
  years: string[],
  months: string[],
  visibility: PatchVisibility
) => {
  const result = await withMeiliEngine(
    () => getPatchIdsByTagFromSearch(input, years, months, visibility),
    () => legacyGetPatchByTag(input, years, months, toPatchWhere(visibility))
  )
  if (result.engine === 'basic') {
    return result.value
  }

  return {
    galgames: await fetchGalgameCardsByIds(result.value.ids, visibility),
    total: result.value.total
  }
}

export const getPatchByTag = async (
  input: z.infer<typeof getPatchByTagSchema>,
  view: PublicListView
) => {
  const years = parseGalgameFilterArray(input.yearString)
  const months = parseGalgameFilterArray(input.monthString)

  try {
    return await withGalgameListCache({
      cacheKeyPrefix: `galgame:list:tag:${input.tagId}`,
      input: {
        ...input,
        // minRatingCount 仅在 rating 排序时生效, 归一化避免同一结果分裂多个 key
        minRatingCount: input.sortField === 'rating' ? input.minRatingCount : 0
      },
      years,
      months,
      view,
      query: () => queryPatchByTag(input, years, months, view.visibility)
    })
  } catch (error) {
    // 筛选值被 Meilisearch 判为非法 (如年份里带孤立代理): 不换引擎, 当业务错误回出
    if (error instanceof MeiliBadRequestError) {
      return '筛选条件格式错误'
    }
    throw error
  }
}
