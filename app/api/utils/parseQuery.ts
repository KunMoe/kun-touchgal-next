import * as z from 'zod'
import { NextRequest } from 'next/server'
import type { ZodSchema } from 'zod'
import { kunZodErrorMap, kunZodErrorText } from '~/validations/errorMap'
import { KUN_BODY_BUDGET } from '~/constants/bodyBudget'
import {
  kunBodyFailureMessage,
  kunBodyFormData,
  kunBodyJson,
  kunReadBody
} from '~/lib/http/readBody'

// 没写文案的约束由 kunZodErrorMap 给中文兜底; 错误串的格式 (人话、每条一行、去重) 见 kunZodErrorText
const parseWith = <T extends ZodSchema>(
  schema: T,
  data: unknown
): z.infer<T> | string => {
  const result = schema.safeParse(data, { error: kunZodErrorMap })
  return result.success ? result.data : kunZodErrorText(result.error)
}

export const kunParseGetQuery = <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): z.infer<T> | string => {
  const { searchParams } = new URL(req.url)
  const queryParams = Object.fromEntries(searchParams.entries())

  return parseWith(schema, queryParams)
}

// 请求体按入口声明的字节预算读 (lib/http/readBody.ts); JSON 入口不写时取 KUN_BODY_BUDGET.json。
// 超出预算或被截断回中文文案, 预算之内的坏 JSON 仍归一为 null 交给 schema (parse-body-json-catch-null)
const parseJsonBody = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T,
  maxBytes: number
): Promise<z.infer<T> | string> => {
  const read = await kunReadBody(req, maxBytes)
  if (!read.ok) {
    return kunBodyFailureMessage(read)
  }

  return parseWith(schema, kunBodyJson(read.bytes))
}

export const kunParsePostBody = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T,
  { maxBytes = KUN_BODY_BUDGET.json }: { maxBytes?: number } = {}
): Promise<z.infer<T> | string> => parseJsonBody(req, schema, maxBytes)

export const kunParsePutBody = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T,
  { maxBytes = KUN_BODY_BUDGET.json }: { maxBytes?: number } = {}
): Promise<z.infer<T> | string> => parseJsonBody(req, schema, maxBytes)

export const kunParseDeleteQuery = <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): z.infer<T> | string => {
  const { searchParams } = new URL(req.url)

  const queryParams = Object.fromEntries(searchParams.entries())
  return parseWith(schema, queryParams)
}

// multipart 的预算没有默认值, 由入口按文件张数声明。解析失败 (含没有 Content-Length 时被截断的
// multipart) 回中文文案, 不抛出
export const kunParseFormData = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T,
  { maxBytes }: { maxBytes: number }
): Promise<z.infer<T> | string> => {
  const read = await kunReadBody(req, maxBytes)
  if (!read.ok) {
    return kunBodyFailureMessage(read)
  }
  const formData = await kunBodyFormData(
    read.bytes,
    req.headers.get('content-type')
  )
  if (!formData) {
    return '表单内容不完整或格式不正确, 请重试'
  }
  const rawData: Record<string, unknown> = {}

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      rawData[key] = value
    } else {
      rawData[key] = value.toString()
    }
  }

  return parseWith(schema, rawData)
}
