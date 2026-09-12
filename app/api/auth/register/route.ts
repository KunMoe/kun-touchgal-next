import { z } from 'zod'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { hashPassword } from '~/app/api/utils/algorithm'
import { verifyVerificationCode } from '~/app/api/utils/verifyVerificationCode'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { insensitiveEquals } from '~/app/api/utils/insensitiveEquals'
import { generateKunToken } from '~/app/api/utils/jwt'
import { kunCookieOptions } from '~/app/api/utils/cookieOptions'
import { registerServerSchema } from '~/validations/reserved-username.server'
import { checkDisableRegister } from '~/app/api/utils/checkDisableRegister'
import { delKv } from '~/lib/redis'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { getRedirectConfig } from '~/app/api/admin/setting/redirect/getRedirectConfig'
import type { UserState } from '~/store/userStore'

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

  const token = await generateKunToken(user.id, name, user.role, '30d', {
    ip,
    userAgent
  })
  const cookie = await cookies()
  cookie.set(
    'kun-galgame-patch-moe-token',
    token,
    kunCookieOptions(30 * 24 * 60 * 60)
  )

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
  const input = await kunParsePostBody(req, registerServerSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const ip = getRemoteIp(req.headers)
  if (!ip) {
    return NextResponse.json('读取请求头失败')
  }

  const response = await register(
    input,
    ip,
    req.headers.get('user-agent') ?? ''
  )
  return NextResponse.json(response)
}
