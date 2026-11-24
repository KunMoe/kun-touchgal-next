import * as z from 'zod'
import { kunLimit, kunPage } from './primitives'

export const resourceSchema = z.object({
  sortField: z.union([
    z.literal('created'),
    z.literal('download'),
    z.literal('like')
  ]),
  sortOrder: z.union([z.literal('asc'), z.literal('desc')]),
  page: kunPage(),
  limit: kunLimit(50)
})
