import { prisma } from '~/prisma/index'
import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { enableUser2FASchema } from '~/validations/user'
import {
  issueBackupCodes,
  SECOND_FACTOR_FAILURE_MESSAGE,
  verifyEnrollmentCode
} from '~/server/auth/secondFactor'

const verifyAndEnable2FA = async (uid: number, token: string, ip: string) => {
  const user = await prisma.user.findUnique({
    where: { id: uid }
  })

  if (!user || !user.two_factor_secret) {
    return '未找到 2FA 密钥, 请先生成 2FA 密钥'
  }

  const verified = await verifyEnrollmentCode(
    uid,
    user.two_factor_secret,
    token,
    { ip }
  )
  if (!verified.ok) {
    return verified.reason === 'invalid'
      ? '2FA 验证码无效'
      : SECOND_FACTOR_FAILURE_MESSAGE[verified.reason]
  }

  const codes = issueBackupCodes()

  await prisma.user.update({
    where: { id: uid },
    data: {
      enable_2fa: true,
      two_factor_backup: codes.stored
    }
  })

  return { backupCode: codes.plain }
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, enableUser2FASchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const result = await verifyAndEnable2FA(
    payload.uid,
    input.token,
    getRemoteIp(req.headers)
  )
  return NextResponse.json(result)
}
