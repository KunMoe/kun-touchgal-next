import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { sendVerificationCodeEmail } from '~/app/api/utils/sendVerificationCodeEmail'
import { sendRegisterEmailVerificationCodeServerSchema } from '~/validations/reserved-username.server'
import { checkKunCaptchaExist } from '~/app/api/utils/verifyKunCaptcha'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { checkDisableRegister } from '~/app/api/utils/checkDisableRegister'
import { prisma } from '~/prisma/index'

const sendRegisterCode = async (
  input: z.infer<typeof sendRegisterEmailVerificationCodeServerSchema>,
  headers: Headers
) => {
  const disableRegisterMessage = await checkDisableRegister()
  if (disableRegisterMessage) {
    return disableRegisterMessage
  }

  const res = await checkKunCaptchaExist(input.captcha)
  if (!res) {
    return '人机验证无效, 请完成人机验证'
  }

  const normalizedName = input.name.toLowerCase()
  const sameUsernameUser = await prisma.user.findFirst({
    where: { name: { equals: normalizedName, mode: 'insensitive' } }
  })
  if (sameUsernameUser) {
    return '您的用户名已经有人注册了, 请修改'
  }

  const normalizedEmail = input.email.toLowerCase()
  const sameEmailUser = await prisma.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } }
  })
  if (sameEmailUser) {
    return '您的邮箱已经有人注册了, 请修改'
  }

  const result = await sendVerificationCodeEmail(
    headers,
    input.email,
    'register'
  )
  if (result) {
    return result
  }
  return {}
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(
    req,
    sendRegisterEmailVerificationCodeServerSchema
  )
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  if (!getRemoteIp(req.headers)) {
    return NextResponse.json('读取请求头失败')
  }

  const response = await sendRegisterCode(input, req.headers)
  return NextResponse.json(response)
}
