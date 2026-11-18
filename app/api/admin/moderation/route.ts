import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { adminModerationPaginationSchema } from '~/validations/admin'
import { getModerationTasks } from './get'
import { can } from '~/constants/permission'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, adminModerationPaginationSchema)
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

  const res = await getModerationTasks(input)
  return NextResponse.json(res)
}
