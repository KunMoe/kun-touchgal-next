import 'server-only'

import { getPatchVisibilityWhere } from '~/utils/actions/getPatchVisibilityWhere'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { shouldBypassSharedCache } from '~/app/api/utils/contentVisibility'
import { getHomeData } from '~/app/api/home/service'

export const kunGetActions = async () => {
  const [visibilityWhere, payload] = await Promise.all([
    getPatchVisibilityWhere(),
    verifyHeaderCookie()
  ])
  const bypassCache = await shouldBypassSharedCache(payload)
  const response = await getHomeData(visibilityWhere, payload, bypassCache)
  return response
}
