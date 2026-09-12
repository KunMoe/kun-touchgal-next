import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getUserInfoSchema } from '~/validations/user'
import { getPatchVisibilityWhere } from '~/app/api/utils/getPatchVisibilityWhere'
import { createAuthLoader } from '~/middleware/_verifyHeaderCookie'
import { getUserPatchResource } from './service'

export async function GET(req: NextRequest) {
  const input = kunParseGetQuery(req, getUserInfoSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const loadAuth = createAuthLoader(req)
  const auth = await loadAuth()
  if (!auth) {
    return NextResponse.json('用户登录失效')
  }
  const visibilityWhere = await getPatchVisibilityWhere(req, loadAuth)

  const response = await getUserPatchResource(
    input,
    visibilityWhere,
    auth.payload
  )
  return NextResponse.json(response)
}
