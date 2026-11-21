import { describe, expect, it } from 'vitest'
import { parseSearchSuggestions, searchSchema } from '~/validations/search'

const baseInput = {
  queryString: JSON.stringify(['测试']),
  limit: 12,
  searchOption: {
    searchInIntroduction: false,
    searchInAlias: false,
    searchInTag: false
  },
  page: 1,
  selectedType: 'all',
  selectedLanguage: 'all',
  selectedPlatform: 'all',
  sortField: 'resource_update_time',
  sortOrder: 'desc',
  selectedYears: ['all'],
  selectedMonths: ['all'],
  minRatingCount: 0
}

const firstMessage = (result: ReturnType<typeof searchSchema.safeParse>) =>
  result.success ? '' : result.error.issues[0].message

describe('searchSchema 年份 / 月份多选上限', () => {
  it('FilterBar 全选年份（unknown + 1980..2026 共 48 项）通过校验', () => {
    const allYears = [
      'unknown',
      ...Array.from({ length: 47 }, (_, i) => String(2026 - i))
    ]
    const result = searchSchema.safeParse({
      ...baseInput,
      selectedYears: allYears,
      selectedMonths: ['01']
    })
    expect(result.success).toBe(true)
  })

  it('全选 12 个月份通过校验', () => {
    const allMonths = Array.from({ length: 12 }, (_, i) =>
      String(i + 1).padStart(2, '0')
    )
    const result = searchSchema.safeParse({
      ...baseInput,
      selectedYears: ['2026'],
      selectedMonths: allMonths
    })
    expect(result.success).toBe(true)
  })

  it('年份超过 64 项时被拒且文案正确', () => {
    const result = searchSchema.safeParse({
      ...baseInput,
      selectedYears: Array.from({ length: 65 }, (_, i) => String(1900 + i))
    })
    expect(result.success).toBe(false)
    expect(firstMessage(result)).toBe('您最多选择 64 组年份')
  })

  it('月份超过 13 项时被拒且文案正确', () => {
    const result = searchSchema.safeParse({
      ...baseInput,
      selectedMonths: Array.from({ length: 14 }, (_, i) => String(i + 1))
    })
    expect(result.success).toBe(false)
    expect(firstMessage(result)).toBe('您最多选择 13 组月份')
  })
})

// P03-02: 小数页码 / 每页条数会让 Meilisearch 回 400 (invalid_search_page /
// invalid_search_hits_per_page), 必须在 schema 硬拒, 不能留给引擎去判
describe('searchSchema 分页参数硬拒小数', () => {
  it('小数 page 被拒', () => {
    expect(searchSchema.safeParse({ ...baseInput, page: 1.5 }).success).toBe(
      false
    )
    expect(searchSchema.safeParse({ ...baseInput, page: '1.5' }).success).toBe(
      false
    )
  })

  it('小数 limit 被拒', () => {
    expect(searchSchema.safeParse({ ...baseInput, limit: 1.5 }).success).toBe(
      false
    )
  })

  it('整数的字符串形式照常通过', () => {
    const result = searchSchema.safeParse({
      ...baseInput,
      page: '2',
      limit: '12'
    })
    expect(result.success && [result.data.page, result.data.limit]).toEqual([
      2, 12
    ])
  })
})

// 这些自由文本会原样进 PG (basic 引擎) 与 Meilisearch 的请求体:
// NUL 让 PG 报 22021 → 500, 孤立代理让 Meilisearch 回 400 malformed_payload
describe('searchSchema 自由文本拒绝 NUL 与孤立代理', () => {
  const BAD = [
    ['NUL', 'a\u0000b'],
    ['孤立代理', 'a\uD83Db']
  ] as const

  it.each(BAD)('类型 / 语言 / 平台含%s被拒', (_name, text) => {
    for (const field of [
      'selectedType',
      'selectedLanguage',
      'selectedPlatform'
    ]) {
      const result = searchSchema.safeParse({ ...baseInput, [field]: text })
      expect(result.success, field).toBe(false)
      expect(firstMessage(result), field).toBe('筛选条件格式错误')
    }
  })

  it.each(BAD)('年份 / 月份的元素含%s被拒', (_name, text) => {
    for (const field of ['selectedYears', 'selectedMonths']) {
      const result = searchSchema.safeParse({
        ...baseInput,
        [field]: ['2020', text]
      })
      expect(result.success, field).toBe(false)
      expect(firstMessage(result), field).toBe('筛选条件格式错误')
    }
  })

  it('成对的代理 (emoji) 照常通过', () => {
    expect(
      searchSchema.safeParse({ ...baseInput, selectedType: '😀' }).success
    ).toBe(true)
  })
})

// 选了具体年份而月份为空: basic 引擎会把年份条件整个丢掉 (不筛), 索引则一条都不命中。
// 界面发不出空的月份 (不选就是 ['all']), 在 schema 拒掉这种请求, 两个引擎就不会各说各话
describe('searchSchema 月份不能是空数组', () => {
  it('空的月份数组被拒', () => {
    const result = searchSchema.safeParse({
      ...baseInput,
      selectedYears: ['2020'],
      selectedMonths: []
    })
    expect(result.success).toBe(false)
    expect(firstMessage(result)).toBe('请至少选择一组月份')
  })

  it("['all'] 照常通过", () => {
    expect(
      searchSchema.safeParse({
        ...baseInput,
        selectedYears: ['2020'],
        selectedMonths: ['all']
      }).success
    ).toBe(true)
  })

  // 年份为空在两个引擎上都是「不筛年份」, 没有分歧, 保持放行
  it('空的年份数组仍然放行', () => {
    expect(
      searchSchema.safeParse({ ...baseInput, selectedYears: [] }).success
    ).toBe(true)
  })
})

describe('searchSchema sortField', () => {
  it('接受发售时间排序 released', () => {
    expect(
      searchSchema.safeParse({ ...baseInput, sortField: 'released' }).success
    ).toBe(true)
  })
})

describe('parseSearchSuggestions 建议项解析', () => {
  it('畸形 JSON 返回错误字符串而非抛错', () => {
    expect(parseSearchSuggestions('abc')).toBe('搜索条件格式错误')
  })

  it('合法 JSON 但非数组被拒', () => {
    expect(parseSearchSuggestions('{}')).toBe('搜索条件格式错误')
  })

  it('元素缺少 name 字段被拒', () => {
    expect(parseSearchSuggestions('[{"type":"keyword"}]')).toBe(
      '搜索条件格式错误'
    )
  })

  it('type 不在词表内被拒', () => {
    expect(parseSearchSuggestions('[{"type":"evil","name":"测试"}]')).toBe(
      '搜索条件格式错误'
    )
  })

  it.each([
    ['关键词含 NUL', '[{"type":"keyword","name":"a\\u0000b"}]'],
    ['标签名含 NUL', '[{"type":"tag","name":"a\\u0000b"}]'],
    ['会社名含孤立代理', '[{"type":"company","name":"a\\ud83db"}]'],
    ['关键词含孤立代理', '[{"type":"keyword","name":"\\ude00"}]']
  ])('%s被拒', (_name, queryString) => {
    expect(parseSearchSuggestions(queryString)).toBe('搜索条件格式错误')
  })

  it('id 超出 int4 上限被拒', () => {
    expect(
      parseSearchSuggestions('[{"type":"tag","id":2147483648,"name":"测试"}]')
    ).toBe('搜索条件格式错误')
  })

  it('合法输入返回类型化数组，省略 mode 归一化为 include', () => {
    const result = parseSearchSuggestions(
      JSON.stringify([
        { type: 'keyword', name: '测试' },
        { type: 'tag', mode: 'exclude', id: 1, name: '悬疑' }
      ])
    )
    expect(result).toEqual([
      { type: 'keyword', mode: 'include', name: '测试' },
      { type: 'tag', mode: 'exclude', id: 1, name: '悬疑' }
    ])
  })
})
