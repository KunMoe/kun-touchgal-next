import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getUserInfoSchema } from '~/validations/user'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getUserPatchResource } from './service'

export async function GET(req: NextRequest) {
  const input = kunParseGetQuery(req, getUserInfoSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const ctx = viewerContextFromRequest(req)
  const viewer = await ctx.viewer()
  if (!viewer) {
    return NextResponse.json('用户登录失效')
  }
  const visibility = await ctx.visibility()

  const response = await getUserPatchResource(input, visibility, viewer)
  return NextResponse.json(response)
}
