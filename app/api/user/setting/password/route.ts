import { prisma } from '~/prisma/index'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { hashPassword } from '~/server/auth/algorithm'
import { requireStepUp } from '~/server/auth/stepUp'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { passwordSchema } from '~/validations/user'

const updatePassword = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, passwordSchema)
  if (typeof input === 'string') {
    return input
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return '用户未登录'
  }
  const ip = getRemoteIp(req.headers)
  if (!ip) {
    return '读取请求头失败'
  }

  const stepUp = await requireStepUp(
    payload.uid,
    'password.change',
    { currentPassword: input.oldPassword },
    { ip }
  )
  if (!stepUp.ok) {
    return stepUp.message
  }

  const hashedPassword = await hashPassword(input.newPassword)

  const { count, stamp } = await applyKunCredentialChange(prisma, {
    uid: payload.uid,
    event: 'password-changed',
    data: { password: hashedPassword }
  })
  if (!count) {
    return '用户不存在'
  }

  // 登出全部会话 (含当前这个) 并清 cookie
  await finishKunSecurityEvent(payload.uid, 'password-changed', {
    current: payload,
    stamp
  })
}

export const POST = async (req: NextRequest) => {
  const res = await updatePassword(req)
  if (typeof res === 'string') {
    return NextResponse.json(res)
  }
  return NextResponse.json({})
}
