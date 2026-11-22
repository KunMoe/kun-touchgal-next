import * as z from 'zod'
import { randomUUID } from 'crypto'
import { cookies } from 'next/headers'
import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsPasswordRehash,
  verifyPassword
} from '~/app/api/utils/algorithm'
import {
  establishKunSession,
  generateKunStatelessToken,
  KUN_BANNED_LOGIN_MESSAGE
} from '~/server/auth/session'
import { kunCookieOptions } from '~/server/auth/cookieOptions'
import { stampValueOf } from '~/server/auth/securityStamp'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import { loginSchema } from '~/validations/auth'
import { prisma } from '~/prisma/index'
import { checkKunCaptchaExist } from '~/app/api/utils/verifyKunCaptcha'
import { getUserStatus } from '~/app/api/user/status/service'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { findUserForLogin } from '~/server/identity/lookup'
import { classifyLoginIdentifier } from '~/validations/identifier'
import {
  createTwoFactorChallenge,
  TWO_FACTOR_CHALLENGE_TTL_SECONDS
} from '~/app/api/auth/_twoFactorChallenge'
import type { UserState } from '~/types/api/session'

const upgradePasswordHash = async (
  userId: number,
  password: string,
  previousPasswordHash: string
) => {
  try {
    // 以旧哈希为条件: 并发改了密码就命中 0 行, 不会把新密码覆盖回去。密码没变, 不刷新安全戳
    await applyKunCredentialChange(prisma, {
      uid: userId,
      event: 'password-rehashed',
      where: { password: previousPasswordHash },
      data: { password: await hashPassword(password) }
    })
    await finishKunSecurityEvent(userId, 'password-rehashed')
  } catch {
    return
  }
}

const login = async (
  input: z.infer<typeof loginSchema>,
  context: { ip: string; userAgent: string }
): Promise<UserState | ({ require2FA: boolean } & KunUser) | string> => {
  const { name, password, captcha } = input
  const res = await checkKunCaptchaExist(captcha)
  if (!res) {
    return '人机验证无效, 请完成人机验证'
  }

  const user = await findUserForLogin(classifyLoginIdentifier(name))

  const isPasswordValid = await verifyPassword(
    password,
    user?.password ?? DUMMY_PASSWORD_HASH
  )
  if (!user || !isPasswordValid) {
    return '用户名或密码错误'
  }
  if (user.status === 2) {
    return KUN_BANNED_LOGIN_MESSAGE
  }

  if (needsPasswordRehash(user.password)) {
    await upgradePasswordHash(user.id, password, user.password)
  }

  if (user.enable_2fa) {
    const jti = randomUUID()
    try {
      await createTwoFactorChallenge(jti, user.id)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to create 2FA challenge', error)
      return '2FA 验证服务暂不可用, 请稍后重试'
    }

    // 带上这一行的安全戳: 两步之间 (最长 10 分钟) 改了密码, 第二步就要求重新登录
    const tempToken = generateKunStatelessToken(
      {
        id: user.id,
        require2FA: true,
        jti,
        cs: stampValueOf(user.security_stamp)
      },
      TWO_FACTOR_CHALLENGE_TTL_SECONDS
    )
    const cookie = await cookies()
    cookie.set(
      'kun-galgame-patch-moe-2fa-token',
      tempToken,
      kunCookieOptions(TWO_FACTOR_CHALLENGE_TTL_SECONDS)
    )
    return {
      require2FA: true,
      id: user.id,
      name: user.name,
      avatar: user.avatar
    }
  }

  const established = await establishKunSession(user, context)
  if (!established.ok) {
    return established.message
  }

  const state = await getUserStatus(user.id)
  return typeof state === 'string' ? state : { ...state, require2FA: false }
}

export const POST = kunRoute.post({
  auth: 'public',
  input: loginSchema,
  handler: async ({ req, input }) => {
    const response = await login(input, {
      ip: getRemoteIp(req.headers),
      userAgent: req.headers.get('user-agent') ?? ''
    })
    return response
  }
})
