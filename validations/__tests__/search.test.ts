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
