import { NextRequest, NextResponse } from 'next/server'
import { getPatchByCompanySchema } from '~/validations/company'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getPatchVisibilityContext } from '~/app/api/utils/getPatchVisibilityContext'
import { createAuthLoader } from '~/middleware/_verifyHeaderCookie'
import { getPatchByCompany } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getPatchByCompanySchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const loadAuth = createAuthLoader(req)
  const visibility = await getPatchVisibilityContext(req, loadAuth)

  const response = await getPatchByCompany(input, visibility)
  return NextResponse.json(response)
}
