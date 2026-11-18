import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { verifyKunTokenWithUser } from '~/app/api/utils/jwt'

// 同一 render 内 verifyHeaderCookie / getBlockedTagIds 共享同一次 user.findUnique
export const loadAuthUser = cache(async () => {
  const cookieStore = await cookies()
  const token = cookieStore.get('kun-galgame-patch-moe-token')?.value
  return verifyKunTokenWithUser(token ?? '')
})
