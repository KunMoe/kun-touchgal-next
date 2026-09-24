import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { getPatchByTagSchema } from '~/validations/tag'
import {
  GalgameCardSelectField,
  toGalgameCardCount
} from '~/constants/api/select'
import {
  buildGalgameDateFilter,
  buildGalgameOrderBy,
  buildGalgameWhere
} from '~/app/api/utils/galgameQuery'
import { withGalgameListCache } from '~/app/api/utils/galgameListCache'
import { parseGalgameFilterArray } from '~/utils/galgameFilter'
import { isMeiliEnabled } from '~/lib/meilisearch'
import {
  buildGalgameSearchFilter,
  buildGalgameSearchSort
} from '~/server/search/filter-builder'
import { queryGalgameIndex } from '~/server/search/query'
import type { PatchVisibilityContext } from '~/app/api/utils/getPatchVisibilityContext'
import type { Prisma } from '~/prisma/generated/prisma/client'

const getPatchByTagFromSearch = async (
  input: z.infer<typeof getPatchByTagSchema>,
  years: string[],
  months: string[],
  visibility: PatchVisibilityContext
) => {
  const filter = buildGalgameSearchFilter({
    selectedType: input.selectedType,
    selectedLanguage: input.selectedLanguage,
    selectedPlatform: input.selectedPlatform,
    years,
    months,
    minRatingCount: input.sortField === 'rating' ? input.minRatingCount : 0,
    contentLimit: visibility.contentLimit,
    blockedTagIds: visibility.blockedTagIds,
    tagId: input.tagId
  })
  if (filter === null) {
    return { galgames: [] as GalgameCard[], total: 0 }
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
  const orderBy = { patch: buildGalgameOrderBy(sortField, sortOrder) }
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
  const galgames: GalgameCard[] = patches.map((gal) => {
    const { favorite_count, resource_count, comment_count, ...rest } = gal
    return {
      ...rest,
      uniqueId: gal.unique_id,
      _count: toGalgameCardCount({
        favorite_count,
        resource_count,
        comment_count
      }),
      averageRating: gal.rating_stat?.avg_overall
        ? Math.round(gal.rating_stat.avg_overall * 10) / 10
        : 0
    }
  })

  return { galgames, total }
}

const queryPatchByTag = async (
  input: z.infer<typeof getPatchByTagSchema>,
  years: string[],
  months: string[],
  visibility: PatchVisibilityContext
) => {
  if (isMeiliEnabled()) {
    try {
      return await getPatchByTagFromSearch(input, years, months, visibility)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Meilisearch 标签列表查询失败，降级为 Prisma 实现:', error)
    }
  }

  return legacyGetPatchByTag(input, years, months, visibility.visibilityWhere)
}

export const getPatchByTag = async (
  input: z.infer<typeof getPatchByTagSchema>,
  visibility: PatchVisibilityContext
) => {
  const years = parseGalgameFilterArray(input.yearString)
  const months = parseGalgameFilterArray(input.monthString)

  return withGalgameListCache({
    cacheKeyPrefix: `galgame:list:tag:${input.tagId}`,
    input: {
      ...input,
      // minRatingCount 仅在 rating 排序时生效, 归一化避免同一结果分裂多个 key
      minRatingCount: input.sortField === 'rating' ? input.minRatingCount : 0
    },
    years,
    months,
    visibilityWhere: visibility.visibilityWhere,
    query: () => queryPatchByTag(input, years, months, visibility)
  })
}
