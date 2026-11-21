import * as z from 'zod'
import { delKv, getKv } from '~/lib/redis'
import { prisma } from '~/prisma/index'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { disableEmailNoticeSchema } from '~/validations/auth'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { verifyUnsubscribeToken } from '~/server/mail/unsubscribeToken'

// 改用签名令牌之前, 群发时按邮箱写进 Redis 的一次性验证码 (七天有效)。发信一侧已不再写它,
// 这个分支只为还在有效期内的旧邮件保留
const LEGACY_CACHE_KEY = 'auth:mail:notice'

const disableByToken = async (uid: number, token: string) => {
  if (!verifyUnsubscribeToken(uid, token)) {
    return '退订链接无效, 请您登录后在用户设置页面取消邮件订阅'
  }

  // 重复点击、账号已不存在都按成功处理: 结果都是不会再收到邮件
  const { count } = await prisma.user.updateMany({
    where: { id: uid },
    data: { enable_email_notice: false }
  })
  if (count) {
    await invalidateUserSession(uid)
  }
  return {}
}

const disableByLegacyCode = async (
  email: string,
  validateEmailCode: string
) => {
  const cacheEmailUUID = await getKv(`${LEGACY_CACHE_KEY}:${email}`)
  if (cacheEmailUUID !== validateEmailCode) {
    return '非法的邮箱验证码, 请您登录后在用户设置页面取消邮件订阅'
  }
  await delKv(`${LEGACY_CACHE_KEY}:${email}`)

  const user = await prisma.user.findUnique({
    where: { email }
  })
  if (!user) {
    return '未找到用户'
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { enable_email_notice: false }
  })
  await invalidateUserSession(user.id)
  return {}
}

const disableEmailNotice = (input: z.infer<typeof disableEmailNoticeSchema>) =>
  'uid' in input
    ? disableByToken(input.uid, input.token)
    : disableByLegacyCode(input.email, input.validateEmailCode)

// 凭邮件里的退订令牌退订, 不需要登录
export const POST = kunRoute.post({
  auth: 'public',
  input: disableEmailNoticeSchema,
  handler: ({ input }) => disableEmailNotice(input)
})
