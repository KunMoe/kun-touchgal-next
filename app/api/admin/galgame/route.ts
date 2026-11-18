import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { adminGalgamePaginationSchema } from '~/validations/admin'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getGalgame } from './service'
import { can } from '~/constants/permission'

export async function GET(req: NextRequest) {
  const input = kunParseGetQuery(req, adminGalgamePaginationSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const ctx = viewerContextFromRequest(req)
  const payload = await ctx.viewer()
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }
  const { contentLimit } = await ctx.visibility()

  const res = await getGalgame(input, contentLimit)
  return NextResponse.json(res)
}
