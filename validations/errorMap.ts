import type * as z from 'zod'

// 解析边界的兜底文案 (T27): 没写文案的约束原先把 zod 的英文默认消息交给用户 toast。zod 的
// 优先级是「检查自带 > 所属 schema > 解析时传入的 error」, 所以已经写好的中文原样保留, 只有原本
// 输出英文的地方会变。
// - 不带字段名: 字段名表又是一张要手工和 schema 同步的表。
// - 不引用 z.locales: 访问它会把语言包带进客户端包; 也不用全局 z.config: 模块级副作用,
//   Turbopack 按层各实例化一份模块时靠不住。所以在每个解析入口显式传入。
// - 只有类型导入, 客户端也能用。

type KunIssue = z.core.$ZodRawIssue

const sizeUnit = (origin: string | undefined) => {
  switch (origin) {
    case 'string':
      return '个字符'
    case 'array':
    case 'set':
      return '项'
    case 'file':
      return '字节'
    default:
      return null
  }
}

const tooSmall = (issue: Extract<KunIssue, { code: 'too_small' }>) => {
  const n = issue.minimum
  const unit = sizeUnit(issue.origin)
  if (unit) {
    if (issue.exact) {
      return `须为 ${n} ${unit}`
    }
    if (issue.origin === 'string' && Number(n) === 1) {
      return '内容不能为空'
    }
    return issue.origin === 'string'
      ? `不能少于 ${n} 个字符`
      : `至少需要 ${n} ${unit}`
  }
  if (issue.origin === 'date') {
    return '日期超出允许的范围'
  }
  return issue.inclusive === false ? `必须大于 ${n}` : `不能小于 ${n}`
}

const tooBig = (issue: Extract<KunIssue, { code: 'too_big' }>) => {
  const n = issue.maximum
  const unit = sizeUnit(issue.origin)
  if (unit) {
    if (issue.exact) {
      return `须为 ${n} ${unit}`
    }
    return `不能超过 ${n} ${unit}`
  }
  // .int() 的安全整数范围检查, 上界是 2^53 - 1, 写出来对用户没有意义
  if (issue.origin === 'int' || issue.origin === 'date') {
    return '数值超出允许的范围'
  }
  return issue.inclusive === false ? `必须小于 ${n}` : `不能大于 ${n}`
}

export const kunZodErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'too_small':
      return tooSmall(issue)
    case 'too_big':
      return tooBig(issue)
    case 'invalid_type':
      if (issue.input === undefined) {
        return '缺少必填的参数'
      }
      if (issue.expected === 'int') {
        return '必须为整数'
      }
      return issue.expected === 'number' ? '必须为数字' : '参数类型不正确'
    case 'invalid_format':
      return '格式不正确'
    case 'invalid_value':
      return '取值不在允许的范围内'
    case 'not_multiple_of':
      return `必须是 ${issue.divisor} 的倍数`
    case 'unrecognized_keys':
      return '包含无法识别的参数'
    default:
      return '参数格式不正确'
  }
}

// 校验失败交给调用方的错误串: 每条 issue 一行。同一个原语的几项检查可以同时失败 (超过安全
// 整数时 .int() 与 max 都报), 它们继承同一句文案, 所以去重。必须是人话而不是 error.message 的
// JSON: 裸 toast 的调用方直接展示, kunErrorHandler 依赖对它 JSON.parse 抛异常落入 catch 分支
export const kunZodErrorText = (error: z.ZodError) =>
  [...new Set(error.issues.map((issue) => issue.message))].join('\n')
