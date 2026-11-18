import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '../utils/parseQuery'
import { resourceSchema } from '~/validations/resource'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchResource } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, resourceSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const view = await viewerContextFromRequest(req).listView({
    personalizedByPendingResource: true
  })

  const response = await getPatchResource(input, view)
  return NextResponse.json(response)
}
