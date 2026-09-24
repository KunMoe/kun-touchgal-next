import * as z from 'zod'
import type { ZodSchema } from 'zod'

export const safeParseSchema = <T extends ZodSchema>(
  schema: T,
  object: Record<string, unknown>
): z.infer<T> | string => {
  const result = schema.safeParse(object)
  if (!result.success) {
    return result.error.issues.map((issue) => issue.message).join('\n')
  }
  return result.data
}
