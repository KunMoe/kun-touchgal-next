'use server'

import * as z from 'zod'
import { adminResourcePaginationSchema } from '~/validations/admin'
import { getPatchResource } from '~/app/api/admin/resource/get'
import { getNSFWHeader } from '~/utils/actions/getNSFWHeader'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminResourcePaginationSchema>
) => {
  const input = await parseSuperAdminAction(
    adminResourcePaginationSchema,
    params
  )
  if (typeof input === 'string') {
    return input
  }

  const nsfwEnable = await getNSFWHeader()

  const response = await getPatchResource(input, nsfwEnable)
  return response
}
