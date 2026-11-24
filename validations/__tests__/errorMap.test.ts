import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { kunZodErrorMap, kunZodErrorText } from '~/validations/errorMap'
import { kunId } from '~/validations/primitives'

const messageOf = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input, { error: kunZodErrorMap })
  return result.success ? null : kunZodErrorText(result.error)
}

describe('kunZodErrorMap: 没写文案的约束给中文', () => {
  it.each([
    ['空字符串', z.string().min(1), '', '内容不能为空'],
    ['字符串过短', z.string().min(2), 'a', '不能少于 2 个字符'],
    ['字符串过长', z.string().max(2), 'abc', '不能超过 2 个字符'],
    ['字符串定长', z.string().length(3), 'ab', '须为 3 个字符'],
    ['数组过少', z.array(z.string()).min(1), [], '至少需要 1 项'],
    ['数组过多', z.array(z.string()).max(1), ['a', 'b'], '不能超过 1 项'],
    ['数字过小', z.number().min(1), 0, '不能小于 1'],
    ['数字过大', z.number().max(3), 5, '不能大于 3'],
    ['数字须大于', z.number().gt(3), 3, '必须大于 3'],
    ['数字须小于', z.number().lt(3), 3, '必须小于 3'],
    ['不是整数', z.number().int(), 1.5, '必须为整数'],
    ['超过安全整数', z.number().int(), 2 ** 53, '数值超出允许的范围'],
    ['不是数字', z.coerce.number(), 'abc', '必须为数字'],
    ['类型不对', z.string(), 5, '参数类型不正确'],
    ['缺字段', z.object({ a: z.string() }), {}, '缺少必填的参数'],
    ['畸形 JSON 请求体', z.object({ a: z.string() }), null, '参数类型不正确'],
    ['格式', z.string().email(), 'x', '格式不正确'],
    ['枚举', z.enum(['a', 'b']), 'c', '取值不在允许的范围内'],
    ['倍数', z.number().multipleOf(2), 3, '必须是 2 的倍数'],
    ['多余的键', z.object({}).strict(), { a: 1 }, '包含无法识别的参数'],
    ['refine', z.string().refine(() => false), 'x', '参数格式不正确'],
    ['联合', z.union([z.literal('a'), z.number()]), 'c', '参数格式不正确']
  ])('%s', (_, schema, input, message) => {
    expect(messageOf(schema, input)).toBe(message)
  })

  it('已经写好的文案原样保留: 检查自带的与 schema 级的都优先', () => {
    expect(messageOf(z.string().min(1, { message: '名称不能为空' }), '')).toBe(
      '名称不能为空'
    )
    expect(messageOf(kunId('评论 ID'), 1.5)).toBe('评论 ID 无效')
  })
})

describe('kunZodErrorText', () => {
  it('每条 issue 一行', () => {
    const schema = z.object({
      a: z.string().min(1, { message: 'A' }),
      b: z.string().min(1, { message: 'B' })
    })
    expect(messageOf(schema, { a: '', b: '' })).toBe('A\nB')
  })

  it('同一原语的几项检查同时失败时只报一次', () => {
    expect(messageOf(kunId('评论 ID'), 9007199254740992)).toBe('评论 ID 无效')
  })
})
