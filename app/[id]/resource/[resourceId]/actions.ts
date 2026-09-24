'use server'

import { cache } from 'react'
import * as z from 'zod'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getPatchResourceDetail } from '~/app/api/patch/resource/detail'

const resourceIdSchema = z.object({
  resourceId: z.coerce.number().min(1).max(9999999)
})

export const kunGetResourceDetailActions = cache(async (resourceId: number) => {
  const input = safeParseSchema(resourceIdSchema, { resourceId })
  if (typeof input === 'string') {
    return input
  }
  const payload = await verifyHeaderCookie()

  const response = await getPatchResourceDetail(input.resourceId, payload)
  return response
})
