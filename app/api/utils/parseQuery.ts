import * as z from 'zod'
import { NextRequest } from 'next/server'
import type { ZodSchema } from 'zod'

// 错误串必须是人话而非 error.message 的 JSON: 裸 toast/setError 调用方直接展示,
// kunErrorHandler 依赖对它 JSON.parse 抛异常落入 catch 分支原样展示
const formatZodErrorMessage = (error: z.ZodError) =>
  error.issues.map((issue) => issue.message).join('\n')

export const kunParseGetQuery = <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): z.infer<T> | string => {
  const { searchParams } = new URL(req.url)
  const queryParams = Object.fromEntries(searchParams.entries())

  const result = schema.safeParse(queryParams)
  if (!result.success) {
    return formatZodErrorMessage(result.error)
  }

  return result.data
}

export const kunParsePostBody = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): Promise<z.infer<T> | string> => {
  const body = await req.json().catch(() => null)

  const result = schema.safeParse(body)
  if (!result.success) {
    return formatZodErrorMessage(result.error)
  }

  return result.data
}

export const kunParsePutBody = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): Promise<z.infer<T> | string> => {
  const body = await req.json().catch(() => null)

  const result = schema.safeParse(body)
  if (!result.success) {
    return formatZodErrorMessage(result.error)
  }

  return result.data
}

export const kunParseDeleteQuery = <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): z.infer<T> | string => {
  const { searchParams } = new URL(req.url)

  const queryParams = Object.fromEntries(searchParams.entries())
  const result = schema.safeParse(queryParams)
  if (!result.success) {
    return formatZodErrorMessage(result.error)
  }

  return result.data
}

export const kunParseFormData = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): Promise<z.infer<T> | string> => {
  const formData = await req.formData()
  const rawData: Record<string, unknown> = {}

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      rawData[key] = value
    } else {
      rawData[key] = value.toString()
    }
  }

  const result = schema.safeParse(rawData)
  if (!result.success) {
    return formatZodErrorMessage(result.error)
  }

  return result.data
}
