'use server'

import * as z from 'zod'
import { adminPaginationSchema } from '~/validations/admin'
import { getPatchResourceApply } from '~/app/api/admin/resource-apply/get'
import { getNSFWHeader } from '~/utils/actions/getNSFWHeader'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminPaginationSchema>
) => {
  const input = await parseSuperAdminAction(adminPaginationSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const nsfwEnable = await getNSFWHeader()

  const response = await getPatchResourceApply(input, nsfwEnable)
  return response
}
