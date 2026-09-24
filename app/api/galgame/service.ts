import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { galgameSchema } from '~/validations/galgame'
import {
  GalgameCardSelectField,
  toGalgameCardCount
} from '~/constants/api/select'
import {
  buildGalgameDateFilter,
  buildGalgameOrderBy,
  buildGalgameWhere
} from '../utils/galgameQuery'
import { withGalgameListCache } from '~/app/api/utils/galgameListCache'
import { parseGalgameFilterArray } from '~/utils/galgameFilter'
import { isMeiliEnabled } from '~/lib/meilisearch'
import {
  buildGalgameSearchFilter,
  buildGalgameSearchSort
} from '~/server/search/filter-builder'
import { queryGalgameIndex } from '~/server/search/query'
import type { GalgameListResponse } from '~/app/api/utils/galgameListCache'
import type { PatchVisibilityContext } from '../utils/getPatchVisibilityContext'
import type { Prisma } from '~/prisma/generated/prisma/client'

const GALGAME_LIST_CACHE_KEY_PREFIX = 'galgame:list'

const getGalgameFromSearch = async (
  input: z.infer<typeof galgameSchema>,
  years: string[],
  months: string[],
  visibility: PatchVisibilityContext
): Promise<GalgameListResponse> => {
  const filter = buildGalgameSearchFilter({
    selectedType: input.selectedType,
    selectedLanguage: input.selectedLanguage,
    selectedPlatform: input.selectedPlatform,
    years,
    months,
    // 列表端点的 minRatingCount 恒生效，与旧实现一致
    minRatingCount: input.minRatingCount,
    contentLimit: visibility.contentLimit,
    blockedTagIds: visibility.blockedTagIds
  })
  if (filter === null) {
    return { galgames: [], total: 0 }
  }

  const { galgames, total } = await queryGalgameIndex({
    q: '',
    filter,
    sort: buildGalgameSearchSort(input.sortField, input.sortOrder),
    page: input.page,
    hitsPerPage: input.limit
  })

  return {
    galgames,
    total
  }
}

// 旧 Prisma 实现：Meilisearch 不可用时的运行时降级路径，勿删
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

  const galgames: GalgameCard[] = data.map((gal) => ({
    id: gal.id,
    uniqueId: gal.unique_id,
    name: gal.name,
    banner: gal.banner,
    view: gal.view,
    download: gal.download,
    type: gal.type,
    language: gal.language,
    platform: gal.platform,
    created: gal.created,
    _count: toGalgameCardCount(gal),
    averageRating: gal.rating_stat?.avg_overall
      ? Math.round(gal.rating_stat.avg_overall * 10) / 10
      : 0
  }))

  return { galgames, total }
}

const queryGalgameList = async (
  input: z.infer<typeof galgameSchema>,
  years: string[],
  months: string[],
  visibility: PatchVisibilityContext
): Promise<GalgameListResponse> => {
  if (isMeiliEnabled()) {
    try {
      return await getGalgameFromSearch(input, years, months, visibility)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Meilisearch 列表查询失败，降级为 Prisma 实现:', error)
    }
  }
  return getGalgameFromPrisma(input, years, months, visibility.visibilityWhere)
}

export const getGalgame = async (
  input: z.infer<typeof galgameSchema>,
  visibility: PatchVisibilityContext
): Promise<GalgameListResponse> => {
  const years = parseGalgameFilterArray(input.yearString)
  const months = parseGalgameFilterArray(input.monthString)

  return withGalgameListCache({
    cacheKeyPrefix: GALGAME_LIST_CACHE_KEY_PREFIX,
    input,
    years,
    months,
    visibilityWhere: visibility.visibilityWhere,
    query: () => queryGalgameList(input, years, months, visibility)
  })
}
