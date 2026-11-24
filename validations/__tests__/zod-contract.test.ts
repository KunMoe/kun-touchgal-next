import * as z from 'zod'
import { describe, expect, it } from 'vitest'

// 值域语义 (T27) 承重于 zod 的这几条行为。它们不是本仓库写的规则, 升级 zod 时可能悄悄变:
// 4.5 起 .max 改为按码点计, 当时注释里按码元推导的预算就失效了, 而且没有任何测试变红。
// 这里逐条钉住; 变红时先确认新语义下 validations/primitives.ts、解析边界的错误映射与
// 送审视图的截断是否仍然成立, 不要机械改断言

const messagesOf = (result: { success: boolean; error?: z.ZodError }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message)

describe('字符串长度按码点计, 不按 UTF-16 码元, 也不按字素', () => {
  it('一个平面外字符算 1 个 (码元是 2)', () => {
    expect(z.string().max(1).safeParse('𠮷').success).toBe(true)
  })

  it('带肤色修饰的 emoji 是 2 个码点, 超过 max(1)', () => {
    expect(z.string().max(1).safeParse('👍🏽').success).toBe(false)
  })

  it('maxLength 可以从 schema 上读出来 (送审视图按它截断)', () => {
    const schema = z.object({ content: z.string().max(10007) })
    expect(schema.shape.content.maxLength).toBe(10007)
  })

  it('孤立代理能通过 z.string() (well-formed 要由出口自己保证)', () => {
    expect(z.string().safeParse('\ud800').success).toBe(true)
  })
})

describe('整数性', () => {
  it('.int() 拒绝小数, 没有 .int() 的数字放行小数', () => {
    expect(z.coerce.number().int().safeParse(5.5).success).toBe(false)
    expect(z.coerce.number().min(1).max(9999999).safeParse(5.5)).toEqual({
      success: true,
      data: 5.5
    })
  })

  it('.int() 还要求在安全整数范围内: 2^53 同时违反它与 max, 报两条', () => {
    const result = z.coerce
      .number({ message: 'X' })
      .int()
      .max(2147483647)
      .safeParse(9007199254740992)
    expect(messagesOf(result)).toEqual(['X', 'X'])
  })
})

describe('coerce 的宽松语义 (#68 保留它, 原语照旧)', () => {
  it.each([
    ['1e3', 1000],
    ['0x10', 16],
    [' 5 ', 5],
    ['', 0],
    [true, 1]
  ])('%j 转成 %j', (input, expected) => {
    expect(z.coerce.number().safeParse(input)).toEqual({
      success: true,
      data: expected
    })
  })

  it('转不成数字的 (NaN、Infinity) 报 invalid_type', () => {
    for (const input of ['abc', undefined, 'Infinity']) {
      const result = z.coerce.number().safeParse(input)
      expect(result.success).toBe(false)
      expect(result.error!.issues[0].code).toBe('invalid_type')
    }
  })
})

describe('文案的优先级: 检查自带 > 所属 schema > 解析时传入的 error', () => {
  const ctxError = () => 'CTX'

  it('schema 级文案被它的各项检查继承: 一条中文覆盖类型、小数与越界', () => {
    const schema = z.coerce.number({ message: 'X' }).int().min(1).max(10)
    for (const input of ['abc', 1.5, 0, 11]) {
      expect(messagesOf(schema.safeParse(input))).toEqual(['X'])
    }
  })

  it('检查自带的文案优先于 schema 级文案', () => {
    const schema = z.string({ message: 'S' }).min(1, { message: 'A' })
    expect(messagesOf(schema.safeParse(''))).toEqual(['A'])
  })

  it('检查自带与 schema 级文案都优先于解析时传入的 error', () => {
    expect(
      messagesOf(
        z.string().min(1, { message: 'A' }).safeParse('', { error: ctxError })
      )
    ).toEqual(['A'])
    expect(
      messagesOf(
        z.string({ message: 'S' }).min(1).safeParse('', { error: ctxError })
      )
    ).toEqual(['S'])
  })

  it('都没写时才用解析时传入的 error; 它返回 undefined 则落回 zod 的英文默认', () => {
    expect(
      messagesOf(z.string().min(1).safeParse('', { error: ctxError }))
    ).toEqual(['CTX'])
    expect(
      messagesOf(
        z
          .string()
          .min(1)
          .safeParse('', { error: () => undefined })
      )
    ).toEqual(['Too small: expected string to have >=1 characters'])
  })
})
