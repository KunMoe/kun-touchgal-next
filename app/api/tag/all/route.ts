import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getTagSchema } from '~/validations/tag'
import { getTag } from './service'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getTagSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const ctx = viewerContextFromRequest(req)
  if (!(await ctx.viewer())) {
    return NextResponse.json('用户未登录')
  }
  const response = await getTag(input, await ctx.visibility())
  return NextResponse.json(response)
}
