'use server'

import * as z from 'zod'
import { getComment } from '~/app/api/admin/comment/get'
import { adminCommentPaginationSchema } from '~/validations/admin'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminCommentPaginationSchema>
) => {
  const input = await parseSuperAdminAction(
    adminCommentPaginationSchema,
    params
  )
  if (typeof input === 'string') {
    return input
  }

  const response = await getComment(input)
  return response
}
