import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getPatchByTagSchema } from '~/validations/tag'
import { getPatchVisibilityContext } from '~/app/api/utils/getPatchVisibilityContext'
import { createAuthLoader } from '~/middleware/_verifyHeaderCookie'
import { getPatchByTag } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getPatchByTagSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const loadAuth = createAuthLoader(req)
  const visibility = await getPatchVisibilityContext(req, loadAuth)

  const response = await getPatchByTag(input, visibility)
  return NextResponse.json(response)
}
