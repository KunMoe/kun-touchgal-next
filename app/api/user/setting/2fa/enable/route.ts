import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { enableUser2FASchema } from '~/validations/user'
import { confirmEnrollment } from '~/server/auth/twoFactorState'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'

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
  if (typeof result === 'string') {
    return NextResponse.json(result)
  }

  await finishKunSecurityEvent(payload.uid, '2fa-enabled', {
    current: payload,
    stamp: result.stamp
  })
  return NextResponse.json({ backupCode: result.backupCode })
}
