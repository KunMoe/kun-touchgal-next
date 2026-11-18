import 'server-only'

import { cache } from 'react'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getUserProfile } from '~/app/api/user/status/info/service'
import { getUserProfileSchema } from '~/validations/user'

// cache 按参数引用去重, key 必须是原始值 id, 供 generateMetadata 与 layout 共享同一次查询
const getCachedUserProfile = cache(async (id: number) => {
  const input = safeParseSchema(getUserProfileSchema, { id })
  if (typeof input === 'string') {
    return input
  }
  const payload = await verifyHeaderCookie()

  const user = await getUserProfile(input, payload)
  return user
})

export const kunGetActions = async (id: number) => {
  return getCachedUserProfile(id)
}
