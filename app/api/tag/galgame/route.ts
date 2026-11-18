import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getPatchByTagSchema } from '~/validations/tag'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchByTag } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getPatchByTagSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const view = await viewerContextFromRequest(req).listView()

  const response = await getPatchByTag(input, view)
  return NextResponse.json(response)
}
