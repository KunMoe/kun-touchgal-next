import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { parseSearchSuggestions, searchSchema } from '~/validations/search'
import {
  GalgameCardSelectField,
  toGalgameCardCount
} from '~/constants/api/select'
import { getPatchVisibilityContext } from '~/app/api/utils/getPatchVisibilityContext'
import { createAuthLoader } from '~/middleware/_verifyHeaderCookie'
import { Prisma } from '~/prisma/generated/prisma/client'
import { isMeiliEnabled } from '~/lib/meilisearch'
import {
  buildAttributesToSearchOn,
  buildGalgameSearchFilter,
  buildGalgameSearchSort,
  buildSearchQuery,
  matchExactIdQuery
} from '~/server/search/filter-builder'
import { queryGalgameIndex } from '~/server/search/query'
import {
  resolveCompanyIdsByNames,
  resolveTagIdsByNames
} from '~/server/search/resolve'
import type { PatchVisibilityContext } from '~/app/api/utils/getPatchVisibilityContext'
import type { SearchSuggestionType } from '~/types/api/search'
import {
  buildGalgameDateFilter,
  buildGalgameOrderBy,
  buildGalgameWhere
} from '../utils/galgameQuery'

const searchGalgameWithMeili = async (
  input: z.infer<typeof searchSchema>,
  visibility: PatchVisibilityContext,
  query: SearchSuggestionType[]
) => {
  const {
    limit,
    searchOption,
    page,
    selectedType = 'all',
    selectedLanguage = 'all',
    selectedPlatform = 'all',
    sortField,
    sortOrder,
    selectedYears = ['all'],
    selectedMonths = ['all'],
    minRatingCount
  } = input

  const keywords = (mode: 'include' | 'exclude') =>
    query
      .filter((item) => item.type === 'keyword' && item.mode === mode)
      .map((item) => item.name.trim())
      .filter(Boolean)

  const includeKeywords = keywords('include')
  const excludeKeywords = keywords('exclude')
  // 单一外部 ID 关键词（vndb / dlsite）走精确直查：以 filter 替代全文匹配
  const exactIdMatch = matchExactIdQuery(includeKeywords, excludeKeywords)

  const suggestions = (type: 'tag' | 'company', mode: 'include' | 'exclude') =>
    query.filter((item) => item.type === type && item.mode === mode)

  const includeTags = suggestions('tag', 'include')
  const excludeTags = suggestions('tag', 'exclude')
  const includeCompanies = suggestions('company', 'include')
  const excludeCompanies = suggestions('company', 'exclude')

  // 无 id 的建议项按名称解析:每类型合并为单条查询,避免按建议数扇出 PG 往返
  const noIdNames = (items: SearchSuggestionType[]) =>
    items.filter((item) => typeof item.id !== 'number').map((item) => item.name)

  const [tagNameToIds, companyNameToIds] = await Promise.all([
    resolveTagIdsByNames([
      ...noIdNames(includeTags),
      ...noIdNames(excludeTags)
    ]),
    resolveCompanyIdsByNames([
      ...noIdNames(includeCompanies),
      ...noIdNames(excludeCompanies)
    ])
  ])

  // 有 id 的建议项直接用 id;无 id 的取解析出的 id 集合(未命中为空组,include 空组即空结果)
  const resolveGroups = (
    items: SearchSuggestionType[],
    nameToIds: Map<string, number[]>
  ) =>
    items.map((item) =>
      typeof item.id === 'number' ? [item.id] : (nameToIds.get(item.name) ?? [])
    )

  const includeTagIdGroups = resolveGroups(includeTags, tagNameToIds)
  const excludeTagIdGroups = resolveGroups(excludeTags, tagNameToIds)
  const includeCompanyIdGroups = resolveGroups(
    includeCompanies,
    companyNameToIds
  )
  const excludeCompanyIdGroups = resolveGroups(
    excludeCompanies,
    companyNameToIds
  )

  const filter = buildGalgameSearchFilter({
    selectedType,
    selectedLanguage,
    selectedPlatform,
    years: selectedYears,
    months: selectedMonths,
    minRatingCount: sortField === 'rating' ? minRatingCount : 0,
    contentLimit: visibility.contentLimit,
    blockedTagIds: visibility.blockedTagIds,
    includeTagIdGroups,
    includeCompanyIdGroups,
    excludeTagIds: excludeTagIdGroups.flat(),
    excludeCompanyIds: excludeCompanyIdGroups.flat(),
    exactId: exactIdMatch ?? undefined
  })
  if (filter === null) {
    return { galgames: [] as GalgameCard[], total: 0 }
  }

  const { galgames, total } = await queryGalgameIndex({
    q: exactIdMatch ? '' : buildSearchQuery(includeKeywords, excludeKeywords),
    filter,
    sort: buildGalgameSearchSort(sortField, sortOrder),
    page,
    hitsPerPage: limit,
    attributesToSearchOn: buildAttributesToSearchOn(searchOption)
  })

  return {
    galgames,
    total
  }
}

// 旧 Prisma 实现：Meilisearch 不可用时的运行时降级路径，勿删
const legacySearchGalgame = async (
  input: z.infer<typeof searchSchema>,
  visibilityWhere: Prisma.patchWhereInput,
  query: SearchSuggestionType[]
) => {
  const {
    limit,
    searchOption,
    page,
    selectedType = 'all',
    selectedLanguage = 'all',
    selectedPlatform = 'all',
    sortField,
    sortOrder,
    selectedYears = ['all'],
    selectedMonths = ['all'],
    minRatingCount
  } = input
  const offset = (page - 1) * limit
  const insensitive = Prisma.QueryMode.insensitive

  const buildKeywordCondition = (keyword: string): Prisma.patchWhereInput => ({
    OR: [
      { name: { contains: keyword, mode: insensitive } },
      { vndb_id: keyword },
      { vndb_relation_id: keyword },
      { dlsite_code: keyword },
      ...(searchOption.searchInIntroduction
        ? [{ introduction: { contains: keyword, mode: insensitive } }]
        : []),
      ...(searchOption.searchInAlias
        ? [
            {
              alias: {
                some: {
                  name: { contains: keyword, mode: insensitive }
                }
              }
            }
          ]
        : []),
      ...(searchOption.searchInTag
        ? [
            {
              tag: {
                some: {
                  tag: { name: { contains: keyword, mode: insensitive } }
                }
              }
            }
          ]
        : [])
    ]
  })

  const buildKeywordExcludeCondition = (
    keyword: string
  ): Prisma.patchWhereInput => ({
    AND: [
      {
        NOT: {
          name: {
            contains: keyword,
            mode: insensitive
          }
        }
      },
      {
        OR: [{ vndb_id: null }, { vndb_id: { not: keyword } }]
      },
      {
        OR: [{ vndb_relation_id: null }, { vndb_relation_id: { not: keyword } }]
      },
      {
        OR: [{ dlsite_code: null }, { dlsite_code: { not: keyword } }]
      },
      ...(searchOption.searchInIntroduction
        ? [
            {
              NOT: {
                introduction: {
                  contains: keyword,
                  mode: insensitive
                }
              }
            }
          ]
        : []),
      ...(searchOption.searchInAlias
        ? [
            {
              alias: {
                none: {
                  name: {
                    contains: keyword,
                    mode: insensitive
                  }
                }
              }
            }
          ]
        : []),
      ...(searchOption.searchInTag
        ? [
            {
              tag: {
                none: {
                  tag: {
                    name: {
                      contains: keyword,
                      mode: insensitive
                    }
                  }
                }
              }
            }
          ]
        : [])
    ]
  })

  const includedKeywords = query
    .filter((item) => item.type === 'keyword' && item.mode === 'include')
    .map((item) => item.name.trim())
    .filter(Boolean)
  const includedTags = query.filter(
    (item) => item.type === 'tag' && item.mode === 'include'
  )
  const includedCompanies = query.filter(
    (item) => item.type === 'company' && item.mode === 'include'
  )
  const excludedKeywords = query
    .filter((item) => item.type === 'keyword' && item.mode === 'exclude')
    .map((item) => item.name)
    .map((item) => item.trim())
    .filter(Boolean)
  const excludedTags = query.filter(
    (item) => item.type === 'tag' && item.mode === 'exclude'
  )
  const excludedCompanies = query.filter(
    (item) => item.type === 'company' && item.mode === 'exclude'
  )

  const dateFilter = buildGalgameDateFilter(selectedYears, selectedMonths)
  const where = buildGalgameWhere({
    selectedType,
    selectedLanguage,
    selectedPlatform,
    minRatingCount: sortField === 'rating' ? minRatingCount : 0,
    visibilityWhere
  })
  const orderBy = buildGalgameOrderBy(sortField, sortOrder)

  const queryCondition = [
    ...includedKeywords.map((q) => buildKeywordCondition(q)),

    visibilityWhere,

    ...includedTags.map((tag) => ({
      tag: {
        some: {
          ...(typeof tag.id === 'number'
            ? { tag_id: tag.id }
            : {
                tag: {
                  OR: [{ name: tag.name }, { alias: { has: tag.name } }]
                }
              })
        }
      }
    })),
    ...includedCompanies.map((company) => ({
      company: {
        some: {
          ...(typeof company.id === 'number'
            ? { company_id: company.id }
            : {
                company: {
                  OR: [
                    { name: company.name },
                    { alias: { has: company.name } },
                    { parent_brand: { has: company.name } }
                  ]
                }
              })
        }
      }
    })),
    ...excludedKeywords.map((q) => buildKeywordExcludeCondition(q)),
    ...excludedTags.map((tag) => ({
      NOT: {
        tag: {
          some: {
            ...(typeof tag.id === 'number'
              ? { tag_id: tag.id }
              : {
                  tag: {
                    OR: [{ name: tag.name }, { alias: { has: tag.name } }]
                  }
                })
          }
        }
      }
    })),
    ...excludedCompanies.map((company) => ({
      NOT: {
        company: {
          some: {
            ...(typeof company.id === 'number'
              ? { company_id: company.id }
              : {
                  company: {
                    OR: [
                      { name: company.name },
                      { alias: { has: company.name } },
                      { parent_brand: { has: company.name } }
                    ]
                  }
                })
          }
        }
      }
    }))
  ]

  const [data, total] = await Promise.all([
    prisma.patch.findMany({
      take: limit,
      skip: offset,
      orderBy,
      where: { AND: queryCondition, ...dateFilter, ...where },
      select: GalgameCardSelectField
    }),
    prisma.patch.count({
      where: { AND: queryCondition, ...dateFilter, ...where }
    })
  ])

  const galgames: GalgameCard[] = data.map((gal) => {
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

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, searchSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const query = parseSearchSuggestions(input.queryString)
  if (typeof query === 'string') {
    return NextResponse.json(query)
  }
  const loadAuth = createAuthLoader(req)
  const visibility = await getPatchVisibilityContext(req, loadAuth)

  if (isMeiliEnabled()) {
    try {
      const response = await searchGalgameWithMeili(input, visibility, query)
      return NextResponse.json(response)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Meilisearch 搜索失败，降级为 Prisma 实现:', error)
    }
  }

  const response = await legacySearchGalgame(
    input,
    visibility.visibilityWhere,
    query
  )
  return NextResponse.json(response)
}
