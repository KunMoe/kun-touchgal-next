import { GALGAME_STOP_WORD, GALGAME_STOP_WORDS } from './settings'

// 将 zod 校验后的筛选参数翻译为 Meilisearch filter 表达式。
// 纯函数，语义逐项对照 app/api/utils/galgameQuery.ts 的 Prisma 实现

// 外部 ID 精确直查命中结果：vndb 走 vndbId OR vndbRelationId，dlsite 走 dlsiteCode
export interface ExactIdMatch {
  kind: 'vndb' | 'dlsite'
  value: string
}

export interface GalgameSearchFilterParams {
  selectedType?: string
  selectedLanguage?: string
  selectedPlatform?: string
  years?: string[]
  months?: string[]
  // 仅传入需要生效的值：/api/galgame 恒生效，其余端点仅 rating 排序时生效
  minRatingCount?: number
  contentLimit?: string | null
  blockedTagIds?: number[]
  tagId?: number
  companyId?: number
  // 每组是一条 AND 条件，组内 id 为 OR（对应无 id 建议项按名称解析出的集合）
  includeTagIdGroups?: number[][]
  excludeTagIds?: number[]
  includeCompanyIdGroups?: number[][]
  excludeCompanyIds?: number[]
  // 命中外部 ID 精确直查时的匹配结果，替代全文匹配（见 matchExactIdQuery）
  exactId?: ExactIdMatch
}

const quote = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const inStringClause = (field: string, values: string[]) =>
  `${field} IN [${values.map(quote).join(', ')}]`

const inNumberClause = (field: string, values: number[]) =>
  `${field} IN [${[...values].sort((a, b) => a - b).join(', ')}]`

// 复刻 buildGalgameDateFilter：future/unknown 不受月份约束，
// 实际年份在月份非 all 时按 年 × 月 组合过滤
export const buildReleasedFilter = (
  years: string[],
  months: string[]
): string => {
  if (years.includes('all')) {
    return ''
  }

  const specialYears = years.filter(
    (year) => year === 'future' || year === 'unknown'
  )
  const exactYears = years.filter(
    (year) => year !== 'future' && year !== 'unknown'
  )

  const clauses: string[] = []
  if (specialYears.length > 0) {
    clauses.push(inStringClause('releasedYear', specialYears))
  }
  if (exactYears.length > 0) {
    const yearClause = inStringClause('releasedYear', exactYears)
    if (months.includes('all')) {
      clauses.push(yearClause)
    } else {
      clauses.push(
        `(${yearClause} AND ${inStringClause('releasedMonth', months)})`
      )
    }
  }

  if (clauses.length === 0) {
    return ''
  }
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`
}

// 返回 null 表示条件不可能命中（include 组解析为空集），调用方直接返回空结果
export const buildGalgameSearchFilter = (
  params: GalgameSearchFilterParams
): string | null => {
  const clauses: string[] = []

  if (params.exactId) {
    const { kind, value } = params.exactId
    clauses.push(
      kind === 'vndb'
        ? `(vndbId = ${quote(value)} OR vndbRelationId = ${quote(value)})`
        : `dlsiteCode = ${quote(value)}`
    )
  }

  if (params.selectedType && params.selectedType !== 'all') {
    clauses.push(`type = ${quote(params.selectedType)}`)
  }
  if (params.selectedLanguage && params.selectedLanguage !== 'all') {
    clauses.push(`language = ${quote(params.selectedLanguage)}`)
  }
  if (params.selectedPlatform && params.selectedPlatform !== 'all') {
    clauses.push(`platform = ${quote(params.selectedPlatform)}`)
  }

  const releasedClause = buildReleasedFilter(
    params.years ?? ['all'],
    params.months ?? ['all']
  )
  if (releasedClause) {
    clauses.push(releasedClause)
  }

  if (params.minRatingCount && params.minRatingCount > 0) {
    clauses.push(`ratingCount >= ${params.minRatingCount}`)
  }

  // 内容分级由服务端强制拼入，绝不信任前端传参
  if (params.contentLimit) {
    clauses.push(`contentLimit = ${quote(params.contentLimit)}`)
  }
  if (params.blockedTagIds && params.blockedTagIds.length > 0) {
    clauses.push(`NOT ${inNumberClause('tagIds', params.blockedTagIds)}`)
  }

  if (params.tagId) {
    clauses.push(`tagIds = ${params.tagId}`)
  }
  if (params.companyId) {
    clauses.push(`companyIds = ${params.companyId}`)
  }

  for (const group of params.includeTagIdGroups ?? []) {
    if (group.length === 0) {
      return null
    }
    clauses.push(
      group.length === 1
        ? `tagIds = ${group[0]}`
        : inNumberClause('tagIds', group)
    )
  }
  for (const group of params.includeCompanyIdGroups ?? []) {
    if (group.length === 0) {
      return null
    }
    clauses.push(
      group.length === 1
        ? `companyIds = ${group[0]}`
        : inNumberClause('companyIds', group)
    )
  }

  if (params.excludeTagIds && params.excludeTagIds.length > 0) {
    clauses.push(`NOT ${inNumberClause('tagIds', params.excludeTagIds)}`)
  }
  if (params.excludeCompanyIds && params.excludeCompanyIds.length > 0) {
    clauses.push(
      `NOT ${inNumberClause('companyIds', params.excludeCompanyIds)}`
    )
  }

  return clauses.join(' AND ')
}

// 排序字段映射，语义对照 buildGalgameOrderBy
const SORT_FIELD_MAP: Record<string, string> = {
  created: 'created',
  resource_update_time: 'resourceUpdateTime',
  view: 'view',
  download: 'download',
  favorite: 'favoriteCount',
  rating: 'avgRating',
  released: 'releasedSort'
}

// id 恒作末位稳定 tiebreaker：并列值的相对顺序否则取决于索引内部序，
// 全量重建前后可能翻动，导致翻页重复/漏条
export const buildGalgameSearchSort = (
  sortField: string,
  sortOrder: 'asc' | 'desc'
): string[] => {
  const field = SORT_FIELD_MAP[sortField]
  return field ? [`${field}:${sortOrder}`, 'id:desc'] : []
}

interface GalgameSearchOption {
  searchInIntroduction: boolean
  searchInAlias: boolean
  searchInTag: boolean
}

// 对应旧实现的"按选项搜索"：name 与外部 ID 恒被搜索；
// company 为有意的召回增强（旧实现关键词不搜会社名）
export const buildAttributesToSearchOn = (
  searchOption: GalgameSearchOption
): string[] => [
  'name',
  'vndbId',
  'vndbRelationId',
  'dlsiteCode',
  'company',
  ...(searchOption.searchInAlias ? ['alias'] : []),
  ...(searchOption.searchInTag ? ['tag'] : []),
  ...(searchOption.searchInIntroduction ? ['introduction'] : [])
]

// 词首的 - 会触发 Meilisearch v1.8+ 负向关键词语法，把「包含」翻转成「排除」
// （如标题 "ATRI -My Dear Moments-"）；- 是分词分隔符，剥离不损失召回。
// " 换成空格：不成对的引号会把后续查询串吞进 phrase，
// 甚至让排除词变成必含词；" 同为分隔符，替换不损失召回
const sanitizeIncludedKeyword = (keyword: string) =>
  keyword
    .replace(/"/g, ' ')
    .replace(/(^|\s)-+(?=\S)/g, '$1')
    .trim()

const searchSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

// Meilisearch 的 CJK 分词不会稳定地把配置的单字停用词从复合查询中移除：
// 例如「魔女的」仍按低相关候选打分，随后被 rankingScoreThreshold 全部剔除。
// 查询侧按词边界移除相同停用词；Intl.Segmenter 可保留「的确」等非独立词。
const normalizeIncludedStopWords = (keyword: string) => {
  if (!GALGAME_STOP_WORDS.some((word) => keyword.includes(word))) {
    return keyword
  }

  let normalized = ''
  for (const { segment } of searchSegmenter.segment(keyword)) {
    normalized += GALGAME_STOP_WORD[segment] === true ? ' ' : segment
  }

  return normalized.replace(/\s+/g, ' ').trim()
}

// 排除关键词统一 quote 成负向 phrase（-"..."），避免词内 - 的负向范围歧义；
// 查询串的 phrase 语法不支持转义，双引号换成空格防提前闭合
const formatNegativeKeyword = (keyword: string) => {
  const stripped = keyword.replace(/"/g, ' ').trim()
  return stripped ? `-"${stripped}"` : ''
}

export const buildSearchQuery = (
  includedKeywords: string[],
  excludedKeywords: string[]
): string => {
  const sanitizedIncludes = includedKeywords
    .map(sanitizeIncludedKeyword)
    .filter(Boolean)
  const normalizedIncludes = sanitizedIncludes
    .map(normalizeIncludedStopWords)
    .filter(Boolean)

  // 纯停用词仍保留原查询，避免 q 变为空字符串后退化为「浏览全部」。
  const includes =
    normalizedIncludes.length > 0 ? normalizedIncludes : sanitizedIncludes

  return [...includes, ...excludedKeywords.map(formatNegativeKeyword)]
    .filter(Boolean)
    .join(' ')
    .trim()
}

// 唯一 include 关键词且形如外部 ID、无 exclude 关键词 → 视为精确直查。
// 全文匹配这些 ID 会前缀渗漏（v1965 命中 v19650/v19658）且依赖分词，精确 filter 唯一确定。
// 归一化对齐入库约定：vndb 系小写、dlsite 大写（Meilisearch filter 本就大小写不敏感，此处仅为一致）
export const matchExactIdQuery = (
  included: string[],
  excluded: string[]
): ExactIdMatch | null => {
  if (excluded.length > 0 || included.length !== 1) {
    return null
  }
  const keyword = included[0].trim()
  if (/^v\d+$/i.test(keyword)) {
    return { kind: 'vndb', value: keyword.toLowerCase() }
  }
  // 与 DLSiteInput 的入库校验一致：仅 RJ / VJ 前缀
  if (/^(?:RJ|VJ)\d+$/i.test(keyword)) {
    return { kind: 'dlsite', value: keyword.toUpperCase() }
  }
  return null
}
