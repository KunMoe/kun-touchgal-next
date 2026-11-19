import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { getPatchIntroduction } from './service'

const uniqueIdSchema = z.object({
  uniqueId: z.string().min(8).max(8)
})
export const GET = kunRoute.get({
  auth: 'public',
  input: uniqueIdSchema,
  handler: ({ input }) => getPatchIntroduction(input)
})
