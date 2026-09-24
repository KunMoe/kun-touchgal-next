'use server'

import { cache } from 'react'
import * as z from 'zod'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getPatchPageData } from '~/app/api/patch/pageData'
import { updatePatchViews } from '~/app/api/patch/views/put'

const uniqueIdSchema = z.object({
  uniqueId: z.string().min(8).max(8)
})

export const kunGetPatchPageDataActions = cache(async (uniqueId: string) => {
  const input = safeParseSchema(uniqueIdSchema, { uniqueId })
  if (typeof input === 'string') {
    return input
  }
  const payload = await verifyHeaderCookie()

  const response = await getPatchPageData(input, payload)
  return response
})

export const kunUpdatePatchViewsActions = async (
  params: z.infer<typeof uniqueIdSchema>
) => {
  const input = safeParseSchema(uniqueIdSchema, params)
  if (typeof input === 'string') {
    return input
  }

  await updatePatchViews(input.uniqueId)
}
