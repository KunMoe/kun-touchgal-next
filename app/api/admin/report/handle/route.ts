import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { adminHandleReportSchema } from '~/validations/admin'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { handleReport } from './service'
import { can } from '~/constants/permission'

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, adminHandleReportSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const response = await handleReport(input, payload.uid)
  return NextResponse.json(response)
}
