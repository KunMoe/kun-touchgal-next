import { NextRequest, NextResponse } from 'next/server'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getHomeData } from './service'

export const GET = async (req: NextRequest) => {
  const view = await viewerContextFromRequest(req).listView({
    personalizedByPendingResource: true
  })

  const response = await getHomeData(view)
  return NextResponse.json(response)
}
