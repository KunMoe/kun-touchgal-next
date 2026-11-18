import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import {
  KUN_NSFW_SETTING_COOKIE,
  SFW_NSFW_HEADER,
  getAuthenticatedNSFWHeader,
  isRestrictedNSFWSetting
} from '~/utils/nsfwHeader'
import { verifyHeaderCookie } from './verifyHeaderCookie'

export const getNSFWHeader = cache(async () => {
  const cookieStore = await cookies()
  const token = cookieStore.get(KUN_NSFW_SETTING_COOKIE)?.value
  if (!isRestrictedNSFWSetting(token)) {
    return SFW_NSFW_HEADER
  }

  const payload = await verifyHeaderCookie()

  if (!payload) {
    return SFW_NSFW_HEADER
  }

  return getAuthenticatedNSFWHeader(token)
})
