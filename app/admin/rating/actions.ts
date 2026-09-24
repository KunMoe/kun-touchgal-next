'use server'

import * as z from 'zod'
import { getRating } from '~/app/api/admin/rating/get'
import { adminRatingPaginationSchema } from '~/validations/admin'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminRatingPaginationSchema>
) => {
  const input = await parseSuperAdminAction(adminRatingPaginationSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const response = await getRating(input)
  return response
}
