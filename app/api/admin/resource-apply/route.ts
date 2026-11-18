import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { adminResourceApplyPaginationSchema } from '~/validations/admin'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchResourceApply } from './get'
import { can } from '~/constants/permission'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, adminResourceApplyPaginationSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const ctx = viewerContextFromRequest(req)
  const payload = await ctx.viewer()
  if (!payload) {
    return NextResponse.json('未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('仅超级管理员可访问')
  }

  const { contentLimit } = await ctx.visibility()

  const res = await getPatchResourceApply(input, contentLimit)
  return NextResponse.json(res)
}
