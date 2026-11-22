import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { sendVerificationCodeEmail } from '~/app/api/utils/sendVerificationCodeEmail'
import { sendRegisterEmailVerificationCodeServerSchema } from '~/validations/reserved-username.server'
import { checkKunCaptchaExist } from '~/app/api/utils/verifyKunCaptcha'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { isEmailTaken, isUsernameTaken } from '~/server/identity/lookup'
import { checkDisableRegister } from '~/app/api/utils/checkDisableRegister'

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

  if (await isUsernameTaken(input.name, { exceptUid: null })) {
    return '您的用户名已经有人注册了, 请修改'
  }

  if (await isEmailTaken(input.email, { exceptUid: null })) {
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
