import { NextRequest, NextResponse } from 'next/server'
import { Totp } from 'time2fa'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { disableUser2FASchema } from '~/validations/user'
import { disable2FA } from '../disable'
import { consumeTwoFactorBackupCode } from '~/app/api/utils/twoFactorBackupCode'

const verifyAndDisable2FA = async (
  uid: number,
  input: { token: string; isBackupCode: boolean }
) => {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      enable_2fa: true,
      two_factor_secret: true
    }
  })

  if (!user || !user.enable_2fa) {
    return '用户未启用 2FA'
  }

  if (!input.isBackupCode && !user.two_factor_secret) {
    return '未找到 2FA 密钥'
  }

  if (input.isBackupCode) {
    const result = await prisma.$transaction(async (tx) => {
      const isValid = await consumeTwoFactorBackupCode(uid, input.token, tx)
      if (!isValid) {
        return null
      }
      return disable2FA(uid, tx)
    })
    return result ?? '验证码无效'
  }

  const isValid = Totp.validate({
    passcode: input.token,
    secret: user.two_factor_secret
  })

  if (!isValid) {
    return '验证码无效'
  }

  return disable2FA(uid)
}

export const POST = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const input = await kunParsePostBody(req, disableUser2FASchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const result = await verifyAndDisable2FA(payload.uid, input)
  return NextResponse.json(result)
}
