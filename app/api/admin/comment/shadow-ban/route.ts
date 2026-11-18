import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { adminUpdateCommentShadowBanSchema } from '~/validations/admin'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { updateCommentShadowBan } from './shadowBan'
import { can } from '~/constants/permission'

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, adminUpdateCommentShadowBanSchema)
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

  const response = await updateCommentShadowBan(input, payload.uid)
  return NextResponse.json(response)
}
