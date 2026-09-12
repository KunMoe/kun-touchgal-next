import { NextRequest, NextResponse } from 'next/server'
import { getPatchVisibilityWhere } from '~/app/api/utils/getPatchVisibilityWhere'
import { createAuthLoader } from '~/middleware/_verifyHeaderCookie'
import { shouldBypassSharedCache } from '~/app/api/utils/contentVisibility'
import { getHomeData } from './service'

export const GET = async (req: NextRequest) => {
  const loadAuth = createAuthLoader(req)
  const [visibilityWhere, auth] = await Promise.all([
    getPatchVisibilityWhere(req, loadAuth),
    loadAuth()
  ])
  const payload = auth?.payload ?? null
  const bypassCache = await shouldBypassSharedCache(payload)

  const response = await getHomeData(visibilityWhere, payload, bypassCache)
  return NextResponse.json(response)
}
