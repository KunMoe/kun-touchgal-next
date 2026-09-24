'use server'

import * as z from 'zod'
import { getAppeals } from '~/app/api/admin/appeal/get'
import { adminAppealPaginationSchema } from '~/validations/admin'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetAppealsActions = async (
  params: z.infer<typeof adminAppealPaginationSchema>
) => {
  const input = await parseSuperAdminAction(adminAppealPaginationSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const response = await getAppeals(input)
  return response
}
