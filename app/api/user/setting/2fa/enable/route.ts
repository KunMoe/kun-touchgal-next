import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { enableUser2FASchema } from '~/validations/user'
import { confirmEnrollment } from '~/server/auth/twoFactorState'

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, enableUser2FASchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const result = await confirmEnrollment(payload.uid, input.token, {
    ip: getRemoteIp(req.headers)
  })
  return NextResponse.json(result)
}
