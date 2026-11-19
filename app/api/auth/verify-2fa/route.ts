import * as z from 'zod'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { establishKunSession } from '~/server/auth/session'
import { prisma } from '~/prisma/index'
import { getUserStatus } from '~/app/api/user/status/service'
import { parseCookies } from '~/utils/cookies'
import { verify2FA } from '~/app/api/utils/verify2FA'
import { verifyLogin2FASchema } from '~/validations/auth'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import {
  consumeTwoFactorChallenge,
  reserveTwoFactorAttempt
} from '~/app/api/auth/_twoFactorChallenge'
import {
  checkTotp,
  SECOND_FACTOR_FAILURE_MESSAGE
} from '~/server/auth/secondFactor'
import { consumeTwoFactorBackupCode } from '~/server/auth/twoFactorBackupCode'
import {
  rejectOnStampMismatch,
  stampValueOf,
  tokenStampOf
} from '~/server/auth/securityStamp'
import type { KunGalgameStatelessPayload } from '~/types/api/session'
import type { TwoFactorAttemptReservation } from '~/app/api/auth/_twoFactorChallenge'

const verifyLogin2FA = async (
  input: z.infer<typeof verifyLogin2FASchema>,
  challenge: KunGalgameStatelessPayload,
  context: { ip: string; userAgent: string }
) => {
  const { token, isBackupCode } = input
  const { id: uid, jti } = challenge

  const user = await prisma.user.findUnique({
    where: { id: uid }
  })

  if (!user || !user.enable_2fa) {
    return '用户未启用 2FA'
  }

  // 第一步之后凭据变过 (改密、重置): 这次挑战作废, 在消费备份码或登记验证码之前就拒绝
  const challengeStamp = tokenStampOf(challenge)
  const userStamp = stampValueOf(user.security_stamp)
  if (
    challengeStamp !== userStamp &&
    rejectOnStampMismatch('two-factor', {
      uid,
      jti,
      tokenStamp: challengeStamp,
      userStamp
    })
  ) {
    const cookie = await cookies()
    cookie.delete('kun-galgame-patch-moe-2fa-token')
    return '2FA 临时令牌已失效, 请重新登录'
  }

  if (isBackupCode) {
    if (!(await consumeTwoFactorBackupCode(uid, token))) {
      return SECOND_FACTOR_FAILURE_MESSAGE.invalid
    }
  } else {
    const totp = await checkTotp(uid, user.two_factor_secret, token)
    if (totp !== 'ok') {
      return SECOND_FACTOR_FAILURE_MESSAGE[totp]
    }
  }

  const cookie = await cookies()
  const challengeConsumed = await consumeTwoFactorChallenge(
    jti,
    uid,
    context.ip
  )
  if (!challengeConsumed) {
    cookie.delete('kun-galgame-patch-moe-2fa-token')
    return '2FA 临时令牌已失效, 请重新登录'
  }
  cookie.delete('kun-galgame-patch-moe-2fa-token')

  const established = await establishKunSession(user, context)
  if (!established.ok) {
    return established.message
  }

  return getUserStatus(user.id)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, verifyLogin2FASchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const tempToken = parseCookies(req.headers.get('cookie') ?? '')[
    'kun-galgame-patch-moe-2fa-token'
  ]
  if (!tempToken) {
    return NextResponse.json('未找到临时令牌')
  }
  const payload = verify2FA(tempToken)
  if (!payload) {
    return NextResponse.json('2FA 临时令牌已过期, 时效为 10 分钟')
  }

  const ip = getRemoteIp(req.headers)
  let reservation: TwoFactorAttemptReservation
  try {
    reservation = await reserveTwoFactorAttempt(payload.jti, payload.id, ip)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to reserve 2FA attempt', error)
    return NextResponse.json('2FA 验证服务暂不可用, 请稍后重试')
  }

  if (!reservation.allowed) {
    const cookie = await cookies()
    cookie.delete('kun-galgame-patch-moe-2fa-token')
    if (reservation.reason === 'expired' || reservation.reason === 'invalid') {
      return NextResponse.json('2FA 临时令牌已失效, 请重新登录')
    }
    return NextResponse.json('2FA 尝试次数过多, 请稍后重新登录')
  }

  let response: Awaited<ReturnType<typeof verifyLogin2FA>>
  try {
    response = await verifyLogin2FA(input, payload, {
      ip,
      userAgent: req.headers.get('user-agent') ?? ''
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to verify 2FA', error)
    return NextResponse.json('2FA 验证服务暂不可用, 请稍后重试')
  }

  if (typeof response === 'string' && reservation.remainingAttempts === 0) {
    const cookie = await cookies()
    cookie.delete('kun-galgame-patch-moe-2fa-token')
    return NextResponse.json('2FA 尝试次数过多, 请重新登录')
  }
  return NextResponse.json(response)
}
