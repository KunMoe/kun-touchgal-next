import { NextRequest, NextResponse } from 'next/server'
import { getPatchByCompanySchema } from '~/validations/company'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchByCompany } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getPatchByCompanySchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const view = await viewerContextFromRequest(req).listView()

  const response = await getPatchByCompany(input, view)
  return NextResponse.json(response)
}
