import type { SortField, SortOrder } from '~/components/galgame/_sort'
import { isWellFormedText } from '~/utils/text/unicode'
import type { GalgameSearchEngine } from '~/types/api/search'

export const DEFAULT_GALGAME_SORT_FIELD: SortField = 'resource_update_time'
export const DEFAULT_GALGAME_SORT_ORDER: SortOrder = 'desc'
export const DEFAULT_GALGAME_FILTER_VALUE = 'all'
export const DEFAULT_GALGAME_FILTER_SELECTION = ['all']
export const DEFAULT_GALGAME_YEAR_STRING = JSON.stringify(
  DEFAULT_GALGAME_FILTER_SELECTION
)
export const DEFAULT_GALGAME_MONTH_STRING = JSON.stringify(
  DEFAULT_GALGAME_FILTER_SELECTION
)
export const DEFAULT_GALGAME_MIN_RATING_COUNT = 10
export const DEFAULT_TAG_COMPANY_MIN_RATING_COUNT = 0

export const getSearchParamValue = (
  value: string | string[] | null | undefined
) => {
  return Array.isArray(value) ? value[0] : (value ?? undefined)
}

// 年份与月份在 buildGalgameDateFilter 中做笛卡尔积, 元素数量无上限时
// 单个请求可展开出数万个 LIKE 谓词。年份选项为 all/future/unknown +
// (当前年 - 1979), 2026 年共 50 项且每年 +1, 月份选项 13 项, 64 覆盖两者
export const MAX_GALGAME_FILTER_VALUES = 64

// 元素会原样进 PG 的前缀匹配与 Meilisearch 的 filter: 带 NUL 或孤立代理的不算合法载荷
// (前者让 PG 报错, 后者让 Meilisearch 判请求体非法), 与坏 JSON 一样回落到默认选项
const isStringArray = (value: unknown): value is string[] => {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && isWellFormedText(item)
    )
  )
}

// 服务端 schema 用它对「合法字符串数组但元素数越界」硬拒, 对齐 /api/search
// 的 z.array().max; 畸形载荷返回 false, 仍由 parseGalgameFilterArray 回落容错
export const exceedsGalgameFilterLimit = (value: string) => {
  try {
    const parsed = JSON.parse(value)
    return isStringArray(parsed) && parsed.length > MAX_GALGAME_FILTER_VALUES
  } catch {
    return false
  }
}

export const parseGalgameFilterArray = (value: string | null | undefined) => {
  if (!value) {
    return [...DEFAULT_GALGAME_FILTER_SELECTION]
  }

  try {
    const parsed = JSON.parse(value)

    return isStringArray(parsed) && parsed.length <= MAX_GALGAME_FILTER_VALUES
      ? parsed
      : [...DEFAULT_GALGAME_FILTER_SELECTION]
  } catch {
    return [...DEFAULT_GALGAME_FILTER_SELECTION]
  }
}

// 只处理缺省, 不做回落: 参数存在即原样透传 (含 NaN / 越界 / 小数),
// 由 validations schema 硬拒渲染整页错误 —— 坏参数不静默修正
export const toNumberParam = (
  value: string | null | undefined,
  fallback: number
) => {
  return value === null || value === undefined ? fallback : Number(value)
}

// debounced 筛选 (评分人数阈值) 不重置页码, 收紧后页码可能越界;
// 响应到达时判定并重置到第 1 页自愈。
// page > 1 保证至多触发一次, 不会因 total 与列表不一致而循环
export const kunShouldResetOverflowPage = (
  total: number,
  listLength: number,
  page: number
) => {
  return total > 0 && listLength === 0 && page > 1
}

// 关键词搜索的两个引擎结果集与顺序不等价。翻页途中引擎换了 (索引故障或恢复),
// 第 n 页与此前看过的各页对不上, 会重复或漏条: 回到第 1 页重新开始。
// firstPageEngine 是第 1 页应答用的引擎; page > 1 保证至多触发一次
export const kunShouldResetEnginePage = (
  firstPageEngine: GalgameSearchEngine | null,
  engine: GalgameSearchEngine,
  page: number
) => {
  return page > 1 && firstPageEngine !== null && engine !== firstPageEngine
}
