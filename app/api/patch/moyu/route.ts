import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getMoyuPatchResourceSchema } from '~/validations/patch'
import { getMoyuPatchResources } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getMoyuPatchResourceSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const response = await getMoyuPatchResources(input.vndbId)
  return NextResponse.json(response)
}
