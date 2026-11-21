export interface SearchSuggestionType {
  type: 'keyword' | 'tag' | 'company'
  mode: 'include' | 'exclude'
  id?: number
  name: string
}

// meili: 索引召回 (按相关度, 有阈值); basic: PG 子串匹配 (严格按所选排序)。
// 两个引擎的结果集与顺序不等价, 见 server/galgame/basicSearch.ts
export type GalgameSearchEngine = 'meili' | 'basic'
