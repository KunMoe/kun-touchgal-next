import * as z from 'zod'
import { searchSchema } from '~/validations/search'
import {
  buildAttributesToSearchOn,
  buildGalgameSearchFilter,
  buildGalgameSearchSort,
  buildSearchQuery,
  matchExactIdQuery
} from '~/server/search/filter-builder'
import { queryGalgameIds } from '~/server/search/query'
import {
  resolveCompanyIdsByNames,
  resolveTagIdsByNames
} from '~/server/search/resolve'
import { withMeiliEngine } from '~/server/search/failure'
import { basicKeywordSearch } from '~/server/galgame/basicSearch'
import { fetchGalgameCardsByIds } from '~/server/galgame/cards'
import {
  toSearchVisibility,
  type PatchVisibility
} from '~/server/viewer/patchVisibility'
import type { GalgameIndexQuery } from '~/server/search/query'
import type { GalgameListResponse } from '~/app/api/utils/galgameListCache'
import type { SortField, SortOrder } from '~/components/galgame/_sort'
import type {
  GalgameSearchEngine,
  SearchSuggestionType
} from '~/types/api/search'

// 标签 / 会社建议项: 带 id 的按 id 匹配, 历史载荷里不带 id 的按名称
export interface GalgameSuggestionRef {
  id?: number
  name: string
}

interface GalgameSuggestionGroup {
  keywords: string[]
  tags: GalgameSuggestionRef[]
  companies: GalgameSuggestionRef[]
}

// 一次关键词搜索要什么, 与用哪个引擎无关
export interface GalgameKeywordSearchSpec {
  include: GalgameSuggestionGroup
  exclude: GalgameSuggestionGroup
  searchIn: { introduction: boolean; alias: boolean; tag: boolean }
  filter: {
    type: string
    language: string
    platform: string
    years: string[]
    months: string[]
    minRatingCount: number
  }
  sort: { field: SortField; order: SortOrder }
  page: number
  limit: number
}

export interface GalgameSearchResponse extends GalgameListResponse {
  engine: GalgameSearchEngine
}

export const toKeywordSearchSpec = (
  input: z.infer<typeof searchSchema>,
  suggestions: SearchSuggestionType[]
): GalgameKeywordSearchSpec => {
  const groupOf = (mode: SearchSuggestionType['mode']) => {
    const ofType = (type: SearchSuggestionType['type']) =>
      suggestions.filter((item) => item.type === type && item.mode === mode)
    return {
      keywords: ofType('keyword')
        .map((item) => item.name.trim())
        .filter(Boolean),
      tags: ofType('tag').map(({ id, name }) => ({ id, name })),
      companies: ofType('company').map(({ id, name }) => ({ id, name }))
    }
  }

  return {
    include: groupOf('include'),
    exclude: groupOf('exclude'),
    searchIn: {
      introduction: input.searchOption.searchInIntroduction,
      alias: input.searchOption.searchInAlias,
      tag: input.searchOption.searchInTag
    },
    filter: {
      type: input.selectedType,
      language: input.selectedLanguage,
      platform: input.selectedPlatform,
      years: input.selectedYears,
      months: input.selectedMonths,
      // 评分人数门槛只在按评分排序时生效
      minRatingCount: input.sortField === 'rating' ? input.minRatingCount : 0
    },
    sort: { field: input.sortField, order: input.sortOrder },
    page: input.page,
    limit: input.limit
  }
}

type NameToIds = Map<string, number[]>

// 带 id 的建议项直接用 id; 不带 id 的取名称解析出的 id 集合 (没解析到就是空组)
const toIdGroups = (refs: GalgameSuggestionRef[], nameToIds: NameToIds) =>
  refs.map((ref) =>
    typeof ref.id === 'number' ? [ref.id] : (nameToIds.get(ref.name) ?? [])
  )

const namesWithoutId = (...groups: GalgameSuggestionRef[][]) =>
  groups
    .flat()
    .filter((ref) => typeof ref.id !== 'number')
    .map((ref) => ref.name)

// 索引按 id 过滤: 不带 id 的标签 / 会社先按名称解析成 id 集合。每类合并为一条 PG 查询,
// 建议项都带 id 时不查库。返回 null 表示条件不可能命中 (必含的标签 / 会社解析为空集)
const toIndexQuery = async (
  spec: GalgameKeywordSearchSpec,
  visibility: PatchVisibility
): Promise<GalgameIndexQuery | null> => {
  const { include, exclude, searchIn, filter, sort } = spec
  const [tagNameToIds, companyNameToIds] = await Promise.all([
    resolveTagIdsByNames(namesWithoutId(include.tags, exclude.tags)),
    resolveCompanyIdsByNames(
      namesWithoutId(include.companies, exclude.companies)
    )
  ])
  // 单一外部 ID 关键词 (vndb / dlsite) 走精确直查: 以 filter 替代全文匹配
  const exactId = matchExactIdQuery(include.keywords, exclude.keywords)

  const indexFilter = buildGalgameSearchFilter({
    selectedType: filter.type,
    selectedLanguage: filter.language,
    selectedPlatform: filter.platform,
    years: filter.years,
    months: filter.months,
    minRatingCount: filter.minRatingCount,
    ...toSearchVisibility(visibility),
    includeTagIdGroups: toIdGroups(include.tags, tagNameToIds),
    includeCompanyIdGroups: toIdGroups(include.companies, companyNameToIds),
    excludeTagIds: toIdGroups(exclude.tags, tagNameToIds).flat(),
    excludeCompanyIds: toIdGroups(exclude.companies, companyNameToIds).flat(),
    exactId: exactId ?? undefined
  })
  if (indexFilter === null) {
    return null
  }

  return {
    q: exactId ? '' : buildSearchQuery(include.keywords, exclude.keywords),
    filter: indexFilter,
    sort: buildGalgameSearchSort(sort.field, sort.order),
    page: spec.page,
    hitsPerPage: spec.limit,
    attributesToSearchOn: buildAttributesToSearchOn({
      searchInIntroduction: searchIn.introduction,
      searchInAlias: searchIn.alias,
      searchInTag: searchIn.tag
    })
  }
}

export const searchGalgames = async (
  spec: GalgameKeywordSearchSpec,
  visibility: PatchVisibility
): Promise<GalgameSearchResponse> => {
  const result = await withMeiliEngine(
    async () => {
      // 名称解析读的是 PG, 只有走索引时才需要 (basic 自己按名称匹配)。它的失败不是
      // Meilisearch 的错误, withMeiliEngine 原样抛出, 不换引擎
      const indexQuery = await toIndexQuery(spec, visibility)
      return indexQuery ? queryGalgameIds(indexQuery) : { ids: [], total: 0 }
    },
    () => basicKeywordSearch(spec, visibility)
  )
  if (result.engine === 'basic') {
    return { ...result.value, engine: 'basic' }
  }

  return {
    galgames: await fetchGalgameCardsByIds(result.value.ids, visibility),
    total: result.value.total,
    engine: 'meili'
  }
}
