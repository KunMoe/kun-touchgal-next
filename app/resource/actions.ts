import 'server-only'

import * as z from 'zod'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { resourceSchema } from '~/validations/resource'
import { getPatchResource } from '~/app/api/resource/service'
import { getViewerContext } from '~/server/viewer/fromHeaders'

export const kunGetActions = async (params: z.infer<typeof resourceSchema>) => {
  const input = safeParseSchema(resourceSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const ctx = await getViewerContext()
  const view = await ctx.listView({ personalizedByPendingResource: true })

  const response = await getPatchResource(input, view)
  return response
}
