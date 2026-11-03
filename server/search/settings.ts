import type { Settings } from 'meilisearch'

export const GALGAME_INDEX = 'galgame'

// 精确总数 / 深分页上限，须大于全库 patch 条数并随增长调整。
// 同时用作相关性阈值下计数查询的 hitsPerPage：强制 Meili 对全部候选打分，
// 拿到阈值之上的精确 totalHits（见 query.ts）。
export const GALGAME_MAX_TOTAL_HITS = 20000

export const GALGAME_STOP_WORD: Record<string, true> = {
  的: true,
  之: true,
  了: true,
  而: true,
  与: true,
  與: true,
  及: true,
  或: true
}
export const GALGAME_STOP_WORDS = Object.keys(GALGAME_STOP_WORD)

export const GALGAME_INDEX_SETTINGS: Settings = {
  // 顺序即字段权重：标题 > 别名 > 标签 > 会社 > 外部 ID > 介绍
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
    // 注册为可过滤以支持外部 ID 精确直查（见 filter-builder matchExactIdQuery）
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
    'created',
    'resourceUpdateTime',
    'view',
    'download',
    'favoriteCount',
    'avgRating',
    'releasedSort',
    // 仅作排序并列时的稳定 tiebreaker
    'id'
  ],

  rankingRules: [
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness'
  ],

  // 与 matchingStrategy:'all' 配套：仅剔除从不承载标题语义、jieba 下能干净切出的虚词/连词。
  // 否则 的/之 会成为「必含词」，让「时间奏响的」这类部分标题命中一切共享 时间+的 的无关标题。
  // 刻意保守：不含代词(你/我/她)、否定(不)、兼作名词/动词的同形词(地/得/着/是/在/有)；含简繁双形(与/與)
  stopWords: GALGAME_STOP_WORDS,

  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
    // 外部 ID 是精确 token，容错会造成错号命中（如 v1965 模糊匹配 v1985）
    disableOnAttributes: ['vndbId', 'vndbRelationId', 'dlsiteCode']
  },

  // 站内俗称/缩写词库，上线后按零结果搜索词持续补充
  synonyms: {},

  // 精确总数与深分页上限，须大于全库 patch 条数并随增长调整
  pagination: { maxTotalHits: GALGAME_MAX_TOTAL_HITS },

  // 明示语言，避免中/日短查询误判分词管线
  localizedAttributes: [
    {
      attributePatterns: ['name', 'alias', 'introduction'],
      locales: ['cmn', 'jpn', 'eng']
    }
  ]
}
