import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GALGAME_FILTER_SELECTION,
  MAX_GALGAME_FILTER_VALUES,
  kunShouldResetEnginePage,
  kunShouldResetOverflowPage,
  parseGalgameFilterArray,
  toNumberParam
} from '~/utils/galgameFilter'
import { buildGalgameDateFilter } from '~/app/api/utils/galgameQuery'

// CJK 单字保证每个元素在 JSON 里恰好 3 字符且不触发转义 (ASCII 段含 " 与 \),
// 251 个元素才能恰好压在 max(1007) 之内
const makeValues = (length: number) =>
  Array.from({ length }, (_, i) => String.fromCharCode(0x4e00 + i))

describe('parseGalgameFilterArray', () => {
  it('保留上限以内的选项', () => {
    const values = makeValues(MAX_GALGAME_FILTER_VALUES)
    expect(parseGalgameFilterArray(JSON.stringify(values))).toEqual(values)
  })

  it('元素数量超上限时回落到默认选项', () => {
    expect(
      parseGalgameFilterArray(
        JSON.stringify(makeValues(MAX_GALGAME_FILTER_VALUES + 1))
      )
    ).toEqual(DEFAULT_GALGAME_FILTER_SELECTION)
  })
})

describe('buildGalgameDateFilter', () => {
  const countConditions = (payload: string) => {
    const values = parseGalgameFilterArray(payload)
    const where = buildGalgameDateFilter(values, values) as { OR?: unknown[] }
    return where.OR?.length ?? 0
  }

  it('满额选项的年月笛卡尔积以上限的平方封顶', () => {
    expect(
      countConditions(JSON.stringify(makeValues(MAX_GALGAME_FILTER_VALUES)))
    ).toBe(MAX_GALGAME_FILTER_VALUES ** 2)
  })

  it('超上限载荷回落为默认选项, 不再展开条件', () => {
    // 251 个元素恰好压在 yearString/monthString 的 max(1007) 之内,
    // 未设上限时会展开出 63001 个 LIKE 谓词
    expect(JSON.stringify(makeValues(251)).length).toBeLessThanOrEqual(1007)
    expect(countConditions(JSON.stringify(makeValues(251)))).toBe(0)
  })
})

describe('toNumberParam', () => {
  it('缺省时取默认值', () => {
    expect(toNumberParam(undefined, 1)).toBe(1)
    expect(toNumberParam(null, 10)).toBe(10)
  })

  it('存在即透传不回落, 坏值交给 schema 硬拒', () => {
    expect(toNumberParam('3', 1)).toBe(3)
    expect(toNumberParam('abc', 1)).toBeNaN()
    expect(toNumberParam('2.9', 1)).toBe(2.9)
    expect(toNumberParam('1e30', 1)).toBe(1e30)
    expect(toNumberParam('-5', 1)).toBe(-5)
  })
})

describe('kunShouldResetOverflowPage', () => {
  it('筛选收紧后页码越界 (有结果但当前页为空) 时重置', () => {
    expect(kunShouldResetOverflowPage(3, 0, 5)).toBe(true)
    expect(kunShouldResetOverflowPage(3, 0, 2)).toBe(true)
    expect(kunShouldResetOverflowPage(50, 0, 5)).toBe(true)
  })

  it('第 1 页不重置, 防止 total 与列表不一致时循环', () => {
    expect(kunShouldResetOverflowPage(3, 0, 1)).toBe(false)
  })

  it('当前页有数据时不重置', () => {
    expect(kunShouldResetOverflowPage(50, 24, 3)).toBe(false)
    expect(kunShouldResetOverflowPage(50, 2, 3)).toBe(false)
  })

  it('total 为 0 时不重置, 交给空态渲染', () => {
    expect(kunShouldResetOverflowPage(0, 0, 5)).toBe(false)
    expect(kunShouldResetOverflowPage(0, 0, 1)).toBe(false)
  })
})

describe('kunShouldResetEnginePage', () => {
  it('翻页途中引擎换了就回到第 1 页, 两个方向都算', () => {
    expect(kunShouldResetEnginePage('meili', 'basic', 2)).toBe(true)
    expect(kunShouldResetEnginePage('basic', 'meili', 5)).toBe(true)
  })

  it('引擎没变时不重置', () => {
    expect(kunShouldResetEnginePage('meili', 'meili', 3)).toBe(false)
    expect(kunShouldResetEnginePage('basic', 'basic', 3)).toBe(false)
  })

  it('第 1 页不重置: 它的应答只负责记下引擎, 否则会循环', () => {
    expect(kunShouldResetEnginePage('meili', 'basic', 1)).toBe(false)
  })

  it('还没有第 1 页的记录时不重置', () => {
    expect(kunShouldResetEnginePage(null, 'basic', 3)).toBe(false)
  })
})
