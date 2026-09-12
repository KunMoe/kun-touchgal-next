import { NextRequest, NextResponse } from 'next/server'
import { getCompanySchema } from '~/validations/company'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getCompany } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getCompanySchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const response = await getCompany(input)
  return NextResponse.json(response)
}
