import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { safeParseSchema } from '../safeParseSchema'

// 页面读取器的解析入口与 kunParse* 同一套错误串: 中文兜底、已写文案优先、去重
describe('safeParseSchema', () => {
  it('成功时返回解析后的数据', () => {
    expect(
      safeParseSchema(z.object({ id: z.coerce.number() }), { id: '3' })
    ).toEqual({ id: 3 })
  })

  it('没写文案的约束是中文, 写了的原样保留, 相同的行只出现一次', () => {
    const schema = z.object({
      name: z.string().min(1),
      a: z.string().min(1, { message: '重复' }),
      b: z.string().min(1, { message: '重复' })
    })
    expect(safeParseSchema(schema, { name: '', a: '', b: '' })).toBe(
      '内容不能为空\n重复'
    )
  })
})
