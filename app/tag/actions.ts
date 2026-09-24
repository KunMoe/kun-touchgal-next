'use server'

import * as z from 'zod'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getTagSchema } from '~/validations/tag'
import { getTag } from '~/app/api/tag/all/service'
import { getBlockedTagIds } from '~/utils/actions/getBlockedTagIds'

export const kunGetActions = async (
  params: z.infer<typeof getTagSchema>,
  authenticatedBlockedTagIds?: number[]
) => {
  const input = safeParseSchema(getTagSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const blockedTagIds = authenticatedBlockedTagIds ?? (await getBlockedTagIds())
  const response = await getTag(input, blockedTagIds)
  return response
}
