import { NextRequest, NextResponse } from 'next/server'
import { toDataURL } from 'qrcode'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { beginTwoFactorEnrollmentSchema } from '~/validations/user'
import { requireStepUp } from '~/server/auth/stepUp'
import { beginEnrollment } from '~/server/auth/twoFactorState'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'

export const POST = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const input = await kunParsePostBody(req, beginTwoFactorEnrollmentSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const stepUp = await requireStepUp(payload.uid, 'twoFactor.enroll', input, {
    ip: getRemoteIp(req.headers)
  })
  if (!stepUp.ok) {
    return NextResponse.json(stepUp.message)
  }

  const key = await beginEnrollment(stepUp.passed)
  if (typeof key === 'string') {
    return NextResponse.json(key)
  }
  await finishKunSecurityEvent(payload.uid, '2fa-secret-staged')

  return NextResponse.json({
    ...key,
    qrCodeUrl: await toDataURL(key.authUrl)
  })
}
