import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { hashPassword } from '~/app/api/utils/algorithm'
import { verifyVerificationCode } from '~/app/api/utils/verifyVerificationCode'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { insensitiveEquals } from '~/app/api/utils/insensitiveEquals'
import { establishKunSession } from '~/server/auth/session'
import { registerServerSchema } from '~/validations/reserved-username.server'
import { checkDisableRegister } from '~/app/api/utils/checkDisableRegister'
import { delKv } from '~/lib/redis'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { getUserStatus } from '~/app/api/user/status/service'

const register = async (
  input: z.infer<typeof registerServerSchema>,
  ip: string,
  userAgent: string
) => {
  const { name, email, code, password } = input

  const disableRegisterMessage = await checkDisableRegister()
  if (disableRegisterMessage) {
    return disableRegisterMessage
  }

  const isCodeValid = await verifyVerificationCode(email, code)
  if (!isCodeValid) {
    return '您的验证码无效, 请重新输入'
  }

  const sameUsernameUser = await prisma.user.findFirst({
    where: { name: insensitiveEquals(name) }
  })
  if (sameUsernameUser) {
    return '您的用户名已经有人注册了, 请修改'
  }

  const sameEmailUser = await prisma.user.findFirst({
    where: { email: insensitiveEquals(email) }
  })
  if (sameEmailUser) {
    return '您的邮箱已经有人注册了, 请修改'
  }

  const hashedPassword = await hashPassword(password)

  // name / email 唯一索引兜底并发注册: 上面两条查重与 create 之间有窗口, 同名或同邮箱
  // 的并发请求会双双通过预检. 索引挡住了重复建号, 这里把 P2002 翻回字符串, 否则用户
  // 拿到 500 而非本仓「业务错误即字符串」的响应约定. name 索引是大小写敏感的 btree,
  // 只兜底完全同名, 与 user/setting/username 同一处未闭合的大小写变体窗口
  let user
  try {
    user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        ip,
        last_login_time: Date.now().toString()
      }
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return '您的用户名或邮箱已经有人注册了, 请修改'
    }
    throw error
  }

  await delKv(email).catch(() => {})

  const established = await establishKunSession(user, { ip, userAgent })
  if (!established.ok) {
    return established.message
  }

  return getUserStatus(user.id)
}

export const POST = kunRoute.post({
  auth: 'public',
  input: registerServerSchema,
  handler: async ({ req, input }) => {
    const ip = getRemoteIp(req.headers)
    if (!ip) {
      return '读取请求头失败'
    }

    const response = await register(
      input,
      ip,
      req.headers.get('user-agent') ?? ''
    )
    return response
  }
})
