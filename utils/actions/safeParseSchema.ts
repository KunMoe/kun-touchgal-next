import * as z from 'zod'
import type { ZodSchema } from 'zod'
import { kunZodErrorMap, kunZodErrorText } from '~/validations/errorMap'

export const safeParseSchema = <T extends ZodSchema>(
  schema: T,
  object: Record<string, unknown>
): z.infer<T> | string => {
  const result = schema.safeParse(object, { error: kunZodErrorMap })
  if (!result.success) {
    return kunZodErrorText(result.error)
  }
  return result.data
}
