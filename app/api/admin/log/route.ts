import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { adminPaginationSchema } from '~/validations/admin'
import { getLog } from './service'

export async function GET(req: NextRequest) {
  const input = kunParseGetQuery(req, adminPaginationSchema)
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

  const res = await getLog(input)
  return NextResponse.json(res)
}
