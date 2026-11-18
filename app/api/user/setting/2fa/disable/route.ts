import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { disableUser2FASchema } from '~/validations/user'
import { disable2FA } from '../disable'
import {
  SECOND_FACTOR_FAILURE_MESSAGE,
  verifySecondFactor
} from '~/server/auth/secondFactor'

const verifyAndDisable2FA = async (
  uid: number,
  input: { token: string; isBackupCode: boolean },
  ip: string
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
    // 备份码的消费与关闭在同一个事务里: 关闭失败时备份码不能白白作废
    const result = await prisma.$transaction(async (tx) => {
      const verified = await verifySecondFactor(
        uid,
        { kind: 'backup', code: input.token },
        { ip, db: tx }
      )
      return verified.ok ? disable2FA(uid, tx) : verified
    })
    return 'ok' in result
      ? SECOND_FACTOR_FAILURE_MESSAGE[result.reason]
      : result
  }

  const verified = await verifySecondFactor(
    uid,
    { kind: 'totp', code: input.token },
    { ip }
  )
  if (!verified.ok) {
    return SECOND_FACTOR_FAILURE_MESSAGE[verified.reason]
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

  const result = await verifyAndDisable2FA(
    payload.uid,
    input,
    getRemoteIp(req.headers)
  )
  return NextResponse.json(result)
}
