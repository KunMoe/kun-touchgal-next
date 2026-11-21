import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { galgameSchema } from '~/validations/galgame'
import { GalgameCardSelectField, toGalgameCard } from '~/constants/api/select'
import {
  buildGalgameDateFilter,
  buildGalgameOrderBy,
  buildGalgameWhere
} from '../utils/galgameQuery'
import { withGalgameListCache } from '~/app/api/utils/galgameListCache'
import { parseGalgameFilterArray } from '~/utils/galgameFilter'
import {
  buildGalgameSearchFilter,
  buildGalgameSearchSort
} from '~/server/search/filter-builder'
import { queryGalgameIds } from '~/server/search/query'
import { MeiliBadRequestError, withMeiliEngine } from '~/server/search/failure'
import { fetchGalgameCardsByIds } from '~/server/galgame/cards'
import type { GalgameListResponse } from '~/app/api/utils/galgameListCache'
import {
  toPatchWhere,
  toSearchVisibility,
  type PatchVisibility,
  type PublicListView
} from '~/server/viewer/patchVisibility'
import type { Prisma } from '~/prisma/generated/prisma/client'

const GALGAME_LIST_CACHE_KEY_PREFIX = 'galgame:list'

// 索引只给这一页的 id 与总数, 卡片由 queryGalgameList 回 PG 取
const getGalgameIdsFromSearch = async (
  input: z.infer<typeof galgameSchema>,
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
    // 列表端点的 minRatingCount 恒生效，与 basic 引擎一致
    minRatingCount: input.minRatingCount,
    ...toSearchVisibility(visibility)
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
const getGalgameFromPrisma = async (
  input: z.infer<typeof galgameSchema>,
  years: string[],
  months: string[],
  visibilityWhere: Prisma.patchWhereInput
): Promise<GalgameListResponse> => {
  const {
    selectedType = 'all',
    selectedLanguage = 'all',
    selectedPlatform = 'all',
    sortField,
    sortOrder,
    page,
    limit,
    minRatingCount
  } = input

  const offset = (page - 1) * limit
  const dateFilter = buildGalgameDateFilter(years, months)
  const where = buildGalgameWhere({
    selectedType,
    selectedLanguage,
    selectedPlatform,
    minRatingCount,
    visibilityWhere
  })
  const orderBy = buildGalgameOrderBy(sortField, sortOrder)

  const [data, total] = await Promise.all([
    prisma.patch.findMany({
      take: limit,
      skip: offset,
      orderBy,
      where: {
        ...dateFilter,
        ...where
      },
      select: GalgameCardSelectField
    }),
    prisma.patch.count({
      where: {
        ...dateFilter,
        ...where
      }
    })
  ])

  const galgames: GalgameCard[] = data.map(toGalgameCard)

  return { galgames, total }
}

const queryGalgameList = async (
  input: z.infer<typeof galgameSchema>,
  years: string[],
  months: string[],
  visibility: PatchVisibility
): Promise<GalgameListResponse> => {
  const result = await withMeiliEngine(
    () => getGalgameIdsFromSearch(input, years, months, visibility),
    () => getGalgameFromPrisma(input, years, months, toPatchWhere(visibility))
  )
  if (result.engine === 'basic') {
    return result.value
  }

  return {
    galgames: await fetchGalgameCardsByIds(result.value.ids, visibility),
    total: result.value.total
  }
}

export const getGalgame = async (
  input: z.infer<typeof galgameSchema>,
  view: PublicListView
): Promise<GalgameListResponse | string> => {
  const years = parseGalgameFilterArray(input.yearString)
  const months = parseGalgameFilterArray(input.monthString)

  try {
    return await withGalgameListCache({
      cacheKeyPrefix: GALGAME_LIST_CACHE_KEY_PREFIX,
      input,
      years,
      months,
      view,
      query: () => queryGalgameList(input, years, months, view.visibility)
    })
  } catch (error) {
    // 筛选值被 Meilisearch 判为非法 (如年份里带孤立代理): 不换引擎, 当业务错误回出
    if (error instanceof MeiliBadRequestError) {
      return '筛选条件格式错误'
    }
    throw error
  }
}
