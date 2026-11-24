import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { INT4_MAX } from '~/constants/db-limits'
import {
  KUN_MAX_PAGE,
  kunId,
  kunInt,
  kunLimit,
  kunNumber,
  kunPage
} from '~/validations/primitives'

const parse = (schema: z.ZodType, input: unknown) => schema.safeParse(input)
const messagesOf = (result: ReturnType<typeof parse>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.message)

describe('kunInt', () => {
  const schema = kunInt(1, 10, '数量无效')

  it.each([5.5, '5.9', 0.1])('拒绝小数 %j', (input) => {
    expect(messagesOf(parse(schema, input))).toEqual(['数量无效'])
  })

  it('照旧放行 coerce 的宽松写法: 1e0 是 1, 0x0a 是 10, 前后空白', () => {
    expect(parse(schema, '1e0')).toEqual({ success: true, data: 1 })
    expect(parse(schema, '0x0a')).toEqual({ success: true, data: 10 })
    expect(parse(schema, ' 7 ')).toEqual({ success: true, data: 7 })
  })

  it('不是数字、越界都报同一句中文', () => {
    for (const input of ['abc', undefined, 0, 11, Infinity]) {
      expect(messagesOf(parse(schema, input))).toEqual(['数量无效'])
    }
  })
})

describe('kunNumber', () => {
  it('放行范围内的小数', () => {
    expect(parse(kunNumber(0, 60, '延时无效'), 1.5)).toEqual({
      success: true,
      data: 1.5
    })
    expect(messagesOf(parse(kunNumber(0, 60, '延时无效'), 60.5))).toEqual([
      '延时无效'
    ])
  })
})

describe('kunId', () => {
  const schema = kunId('评论 ID')

  it('上界是 int4 的类型边界', () => {
    expect(parse(schema, INT4_MAX)).toEqual({ success: true, data: INT4_MAX })
    expect(parse(schema, String(INT4_MAX))).toEqual({
      success: true,
      data: INT4_MAX
    })
    expect(messagesOf(parse(schema, INT4_MAX + 1))).toEqual(['评论 ID 无效'])
  })

  it('拒绝小数、0 与负数; 1e3 照旧是 1000', () => {
    for (const input of [5.5, '5.9', 0, -1]) {
      expect(messagesOf(parse(schema, input))).toEqual(['评论 ID 无效'])
    }
    expect(parse(schema, '1e3')).toEqual({ success: true, data: 1000 })
    expect(parse(schema, '0x10')).toEqual({ success: true, data: 16 })
  })

  it('超过安全整数时 .int() 与 max 都失败, 文案相同 (解析边界负责去重)', () => {
    expect(messagesOf(parse(schema, 9007199254740992))).toEqual([
      '评论 ID 无效',
      '评论 ID 无效'
    ])
  })
})

describe('kunPage / kunLimit', () => {
  it('页码上界保持 9999999', () => {
    expect(KUN_MAX_PAGE).toBe(9999999)
    expect(parse(kunPage(), KUN_MAX_PAGE).success).toBe(true)
    expect(messagesOf(parse(kunPage(), KUN_MAX_PAGE + 1))).toEqual(['页码无效'])
    expect(messagesOf(parse(kunPage(), 1.5))).toEqual(['页码无效'])
  })

  it('每页数量的文案带上界', () => {
    expect(parse(kunLimit(24), 24).success).toBe(true)
    expect(messagesOf(parse(kunLimit(24), 25))).toEqual([
      '每页数量须为 1～24 的整数'
    ])
    expect(messagesOf(parse(kunLimit(24), 2.5))).toEqual([
      '每页数量须为 1～24 的整数'
    ])
  })

  it('可选与默认值照常组合', () => {
    expect(parse(kunPage().optional(), undefined)).toEqual({
      success: true,
      data: undefined
    })
    expect(parse(kunLimit(10).default(5), undefined)).toEqual({
      success: true,
      data: 5
    })
  })
})

describe('输入类型是 number (表单复用的 schema 靠这个泛型)', () => {
  it('z.input 不是 unknown', () => {
    const schema = z.object({ id: kunId('游戏 ID') })
    const input: z.input<typeof schema> = { id: 1 }
    // @ts-expect-error 输入类型是 number, 不收字符串
    const wrong: z.input<typeof schema> = { id: '1' }
    expect(schema.safeParse(input).success).toBe(true)
    expect(schema.safeParse(wrong).success).toBe(true)
  })
})
