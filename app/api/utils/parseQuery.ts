import * as z from 'zod'
import { NextRequest } from 'next/server'
import type { ZodSchema } from 'zod'
import { kunZodErrorMap, kunZodErrorText } from '~/validations/errorMap'

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

export const kunParsePostBody = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): Promise<z.infer<T> | string> => {
  const body = await req.json().catch(() => null)

  return parseWith(schema, body)
}

export const kunParsePutBody = async <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): Promise<z.infer<T> | string> => {
  const body = await req.json().catch(() => null)

  return parseWith(schema, body)
}

export const kunParseDeleteQuery = <T extends ZodSchema>(
  req: NextRequest,
  schema: T
): z.infer<T> | string => {
  const { searchParams } = new URL(req.url)

  const queryParams = Object.fromEntries(searchParams.entries())
  return parseWith(schema, queryParams)
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

  return parseWith(schema, rawData)
}
