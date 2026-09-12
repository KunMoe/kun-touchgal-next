import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { adminFeedbackPaginationSchema } from '~/validations/admin'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { getFeedback } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, adminFeedbackPaginationSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 4) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const response = await getFeedback(input)
  return NextResponse.json(response)
}
