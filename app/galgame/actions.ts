import 'server-only'

import * as z from 'zod'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { galgameSchema } from '~/validations/galgame'
import { getGalgame } from '~/app/api/galgame/service'
import { getViewerContext } from '~/server/viewer/fromHeaders'

export const kunGetActions = async (params: z.infer<typeof galgameSchema>) => {
  const input = safeParseSchema(galgameSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const view = await (await getViewerContext()).listView()

  const response = await getGalgame(input, view)
  return response
}
