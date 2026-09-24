import * as z from 'zod'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { generateKunToken } from '~/app/api/utils/jwt'
import { kunCookieOptions } from '~/app/api/utils/cookieOptions'
import { prisma } from '~/prisma/index'
import { getRedirectConfig } from '~/app/api/admin/setting/redirect/getRedirectConfig'
import { updateUserLastLoginTime } from '~/app/api/user/status/service'
import { Totp } from 'time2fa'
import { parseCookies } from '~/utils/cookies'
import { verify2FA } from '~/app/api/utils/verify2FA'
import { verifyLogin2FASchema } from '~/validations/auth'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import {
  consumeTwoFactorChallenge,
  reserveTwoFactorAttempt
} from '~/app/api/auth/_twoFactorChallenge'
import { consumeTwoFactorBackupCode } from '~/app/api/utils/twoFactorBackupCode'
import type { TwoFactorAttemptReservation } from '~/app/api/auth/_twoFactorChallenge'
import type { UserState } from '~/store/userStore'

const verifyLogin2FA = async (
  input: z.infer<typeof verifyLogin2FASchema>,
  uid: number,
  jti: string,
  context: { ip: string; userAgent: string }
) => {
  const { token, isBackupCode } = input

  const user = await prisma.user.findUnique({
    where: { id: uid }
  })

  if (!user || !user.enable_2fa) {
    return '用户未启用 2FA'
  }

  let isValid = false

  if (isBackupCode) {
    isValid = await consumeTwoFactorBackupCode(uid, token)
  } else {
    isValid = Totp.validate({
      passcode: token,
      secret: user.two_factor_secret
    })
  }

  if (!isValid) {
    return '验证码无效'
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

  const accessToken = await generateKunToken(
    user.id,
    user.name,
    user.role,
    '30d',
    context
  )
  cookie.set(
    'kun-galgame-patch-moe-token',
    accessToken,
    kunCookieOptions(30 * 24 * 60 * 60)
  )
  await updateUserLastLoginTime(user.id)

  const redirectConfig = await getRedirectConfig()
  const responseData: UserState = {
    uid: user.id,
    name: user.name,
    avatar: user.avatar,
    bio: user.bio,
    moemoepoint: user.moemoepoint,
    role: user.role,
    dailyCheckIn: user.daily_check_in,
    dailyImageLimit: user.daily_image_count,
    dailyUploadLimit: user.daily_upload_size,
    enableEmailNotice: user.enable_email_notice,
    allowPrivateMessage: user.allow_private_message,
    blockedTagIds: user.blocked_tag_ids,
    ...redirectConfig
  }

  return responseData
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
    response = await verifyLogin2FA(input, payload.id, payload.jti, {
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
