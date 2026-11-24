import * as z from 'zod'
import { MAX_GALGAME_FILTER_VALUES } from '~/utils/galgameFilter'
import { isWellFormedText } from '~/utils/text/unicode'
import { minRatingCountSchema } from './galgame'
import type { SearchSuggestionType } from '~/types/api/search'

// 筛选值与建议项的名称会原样进 PG (basic 引擎) 与 Meilisearch 的请求体: NUL 让 PG 报
// 22021, 孤立代理让 Meilisearch 判请求体非法。在入口拒掉, 不留给哪个引擎去报错
const filterText = (schema: z.ZodString) =>
  schema.refine(isWellFormedText, { message: '筛选条件格式错误' })

export const searchSchema = z.object({
  queryString: z
    .string()
    .min(1)
    .max(1007, { message: '您的搜素字符串最大为 1007 个字符' }),
  limit: z.coerce.number().int().min(1).max(24),
  searchOption: z.object({
    searchInIntroduction: z.boolean().default(false),
    searchInAlias: z.boolean().default(false),
    searchInTag: z.boolean().default(false)
  }),

  page: z.coerce.number().int().min(1).max(9999999),
  selectedType: filterText(z.string().min(1).max(107)),
  selectedLanguage: filterText(z.string().min(1).max(107)),
  selectedPlatform: filterText(z.string().min(1).max(107)),
  sortField: z.union([
    z.literal('resource_update_time'),
    z.literal('created'),
    z.literal('rating'),
    z.literal('view'),
    z.literal('download'),
    z.literal('favorite'),
    z.literal('released')
  ]),
  sortOrder: z.union([z.literal('asc'), z.literal('desc')]),
  selectedYears: z
    .array(filterText(z.string().trim().min(1).max(50)))
    .max(MAX_GALGAME_FILTER_VALUES, {
      message: `您最多选择 ${MAX_GALGAME_FILTER_VALUES} 组年份`
    }),
  // 不能为空: 选了具体年份而月份为空时, basic 引擎会把年份条件整个丢掉 (不筛),
  // 索引则一条都不命中。界面不选月份时发的是 ['all']
  selectedMonths: z
    .array(filterText(z.string().trim().min(1).max(50)))
    .min(1, { message: '请至少选择一组月份' })
    .max(13, { message: '您最多选择 13 组月份' }),
  minRatingCount: minRatingCountSchema.default(10)
})

// mode 带 default：历史 payload 可不带 mode，缺省归一化为 include
export const searchSuggestionArraySchema = z.array(
  z.object({
    type: z.enum(['keyword', 'tag', 'company']),
    mode: z.enum(['include', 'exclude']).default('include'),
    id: z.number().int().min(1).max(2147483647).optional(),
    name: z.string().refine(isWellFormedText)
  })
)

export const parseSearchSuggestions = (
  queryString: string
): SearchSuggestionType[] | string => {
  let raw: unknown
  try {
    raw = JSON.parse(queryString)
  } catch {
    return '搜索条件格式错误'
  }
  const result = searchSuggestionArraySchema.safeParse(raw)
  if (!result.success) {
    return '搜索条件格式错误'
  }
  return result.data
}

export const searchTagSchema = z.object({
  query: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(107, { message: '单个搜索关键词最大长度为 107' })
    )
    .min(1)
    .max(10, { message: '您最多使用 10 组关键词' })
})
