'use server'

import * as z from 'zod'
import { adminUserPaginationSchema } from '~/validations/admin'
import { getUserInfo } from '~/app/api/admin/user/get'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminUserPaginationSchema>
) => {
  const input = await parseSuperAdminAction(adminUserPaginationSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const response = await getUserInfo(input)
  return response
}
