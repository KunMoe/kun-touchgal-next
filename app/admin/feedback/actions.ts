'use server'

import * as z from 'zod'
import { adminPaginationSchema } from '~/validations/admin'
import { getFeedback } from '~/app/api/admin/feedback/service'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminPaginationSchema>
) => {
  const input = await parseSuperAdminAction(adminPaginationSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const response = await getFeedback(input)
  return response
}
