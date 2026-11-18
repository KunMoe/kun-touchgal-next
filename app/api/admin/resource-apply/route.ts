import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { adminResourceApplyPaginationSchema } from '~/validations/admin'
import { getNSFWHeader } from '~/app/api/utils/getNSFWHeader'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { getPatchResourceApply } from './get'
import { can } from '~/constants/permission'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, adminResourceApplyPaginationSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('仅超级管理员可访问')
  }

  const nsfwEnable = await getNSFWHeader(req, payload)

  const res = await getPatchResourceApply(input, nsfwEnable)
  return NextResponse.json(res)
}
