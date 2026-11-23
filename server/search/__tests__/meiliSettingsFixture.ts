// 测试夹具 (不是测试文件): Meilisearch v1.15.2 的 getSettings() 原样输出, 含引擎补的默认值。
// 返回时 sortableAttributes / stopWords / typoTolerance.disableOnAttributes 已排序,
// filterableAttributes 保持写入顺序

import type { Settings } from 'meilisearch'

// 本地常驻容器里下发过 GALGAME_INDEX_SETTINGS 的 galgame 索引
export const LOCAL_V1_15_2_SETTINGS: Settings = {
  displayedAttributes: ['*'],
  searchableAttributes: [
    'name',
    'alias',
    'tag',
    'company',
    'vndbId',
    'vndbRelationId',
    'dlsiteCode',
    'introduction'
  ],
  filterableAttributes: [
    'vndbId',
    'vndbRelationId',
    'dlsiteCode',
    'type',
    'language',
    'platform',
    'contentLimit',
    'tagIds',
    'companyIds',
    'releasedYear',
    'releasedMonth',
    'ratingCount'
  ],
  sortableAttributes: [
    'avgRating',
    'created',
    'download',
    'favoriteCount',
    'id',
    'releasedSort',
    'resourceUpdateTime',
    'view'
  ],
  rankingRules: [
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness'
  ],
  stopWords: ['与', '之', '了', '及', '或', '的', '而', '與'],
  nonSeparatorTokens: [],
  separatorTokens: [],
  dictionary: [],
  synonyms: {},
  distinctAttribute: null,
  proximityPrecision: 'byWord',
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
    disableOnWords: [],
    disableOnAttributes: ['dlsiteCode', 'vndbId', 'vndbRelationId'],
    disableOnNumbers: false
  },
  faceting: { maxValuesPerFacet: 100, sortFacetValuesBy: { '*': 'alpha' } },
  pagination: { maxTotalHits: 20000 },
  embedders: {},
  searchCutoffMs: null,
  localizedAttributes: [
    {
      attributePatterns: ['name', 'alias', 'introduction'],
      locales: ['cmn', 'jpn', 'eng']
    }
  ],
  facetSearch: true,
  prefixSearch: 'indexingTime'
}

// createIndex 之后、下发任何 settings 之前的新索引
export const FRESH_V1_15_2_SETTINGS: Settings = {
  displayedAttributes: ['*'],
  searchableAttributes: ['*'],
  filterableAttributes: [],
  sortableAttributes: [],
  rankingRules: [
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness'
  ],
  stopWords: [],
  nonSeparatorTokens: [],
  separatorTokens: [],
  dictionary: [],
  synonyms: {},
  distinctAttribute: null,
  proximityPrecision: 'byWord',
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 5, twoTypos: 9 },
    disableOnWords: [],
    disableOnAttributes: [],
    disableOnNumbers: false
  },
  faceting: { maxValuesPerFacet: 100, sortFacetValuesBy: { '*': 'alpha' } },
  pagination: { maxTotalHits: 1000 },
  embedders: {},
  searchCutoffMs: null,
  localizedAttributes: null,
  facetSearch: true,
  prefixSearch: 'indexingTime'
}
