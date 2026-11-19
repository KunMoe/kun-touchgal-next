import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { getPatchById } from './get'
import { deletePatchById } from './delete'

const uniqueIdSchema = z.object({
  uniqueId: z.string().min(8).max(8)
})

const patchIdSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999)
})

export const GET = kunRoute.get({
  auth: 'optional',
  input: uniqueIdSchema,
  handler: ({ input, actor }) => getPatchById(input, actor)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'galgame.delete',
  input: patchIdSchema,
  handler: ({ input }) => deletePatchById(input)
})
