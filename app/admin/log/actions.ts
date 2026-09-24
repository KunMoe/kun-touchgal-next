'use server'

import * as z from 'zod'
import { adminPaginationSchema } from '~/validations/admin'
import { getLog } from '~/app/api/admin/log/service'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminPaginationSchema>
) => {
  const input = await parseSuperAdminAction(adminPaginationSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const response = await getLog(input)
  return response
}
