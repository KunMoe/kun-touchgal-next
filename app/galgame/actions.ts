'use server'

import * as z from 'zod'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { galgameSchema } from '~/validations/galgame'
import { getGalgame } from '~/app/api/galgame/service'
import { getPatchVisibilityContext } from '~/utils/actions/getPatchVisibilityContext'

export const kunGetActions = async (params: z.infer<typeof galgameSchema>) => {
  const input = safeParseSchema(galgameSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const visibility = await getPatchVisibilityContext()

  const response = await getGalgame(input, visibility)
  return response
}
