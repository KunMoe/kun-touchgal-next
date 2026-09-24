'use server'

import * as z from 'zod'
import { getUserInfoSchema } from '~/validations/user'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getPatchVisibilityWhere } from '~/utils/actions/getPatchVisibilityWhere'
import { getUserPatchResource } from '~/app/api/user/profile/resource/service'

export const kunGetActions = async (
  params: z.infer<typeof getUserInfoSchema>
) => {
  const input = safeParseSchema(getUserInfoSchema, params)
  if (typeof input === 'string') {
    return input
  }
  const payload = await verifyHeaderCookie()
  if (!payload) {
    return '用户登录失效'
  }

  const visibilityWhere = await getPatchVisibilityWhere()

  const response = await getUserPatchResource(input, visibilityWhere, payload)
  return response
}
