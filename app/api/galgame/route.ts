import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '../utils/parseQuery'
import { galgameSchema } from '~/validations/galgame'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getGalgame } from './service'
export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, galgameSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const view = await viewerContextFromRequest(req).listView()

  const response = await getGalgame(input, view)
  return NextResponse.json(response)
}
