import 'server-only'

import * as z from 'zod'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getTagSchema } from '~/validations/tag'
import { getTag } from '~/app/api/tag/all/service'
import { getViewerContext } from '~/server/viewer/fromHeaders'

export const kunGetActions = async (params: z.infer<typeof getTagSchema>) => {
  const input = safeParseSchema(getTagSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const visibility = await (await getViewerContext()).visibility()
  const response = await getTag(input, visibility)
  return response
}
