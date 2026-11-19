import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { sendVerificationCodeEmail } from '~/app/api/utils/sendVerificationCodeEmail'
import { sendRegisterEmailVerificationCodeServerSchema } from '~/validations/reserved-username.server'
import { checkKunCaptchaExist } from '~/app/api/utils/verifyKunCaptcha'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { insensitiveEquals } from '~/app/api/utils/insensitiveEquals'
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

  const sameUsernameUser = await prisma.user.findFirst({
    where: { name: insensitiveEquals(input.name) }
  })
  if (sameUsernameUser) {
    return '您的用户名已经有人注册了, 请修改'
  }

  const sameEmailUser = await prisma.user.findFirst({
    where: { email: insensitiveEquals(input.email) }
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

export const POST = kunRoute.post({
  auth: 'public',
  input: sendRegisterEmailVerificationCodeServerSchema,
  handler: async ({ req, input }) => {
    if (!getRemoteIp(req.headers)) {
      return '读取请求头失败'
    }

    const response = await sendRegisterCode(input, req.headers)
    return response
  }
})
