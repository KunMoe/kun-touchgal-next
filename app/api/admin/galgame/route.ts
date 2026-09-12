import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { adminGalgamePaginationSchema } from '~/validations/admin'
import { getNSFWHeader } from '~/app/api/utils/getNSFWHeader'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { getGalgame } from './service'

export async function GET(req: NextRequest) {
  const input = kunParseGetQuery(req, adminGalgamePaginationSchema)
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
  const nsfwEnable = await getNSFWHeader(req, payload)

  const res = await getGalgame(input, nsfwEnable)
  return NextResponse.json(res)
}
