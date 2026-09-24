import * as z from 'zod'

export const resourceSchema = z.object({
  sortField: z.union([
    z.literal('created'),
    z.literal('download'),
    z.literal('like')
  ]),
  sortOrder: z.union([z.literal('asc'), z.literal('desc')]),
  page: z.coerce.number().int().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(50)
})
