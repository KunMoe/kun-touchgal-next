import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { forgotPasswordRequestSchema } from '~/validations/forgot'
import { sendResetPasswordLinkEmail } from '~/app/api/utils/sendResetPasswordLinkEmail'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { findUserByEmailForReset } from '~/server/identity/lookup'
import { getKv, setKv } from '~/lib/redis'
import { checkKunCaptchaExist } from '~/app/api/utils/verifyKunCaptcha'

const requestReset = async (
  input: z.infer<typeof forgotPasswordRequestSchema>,
  headers: Headers
) => {
  const captchaValid = await checkKunCaptchaExist(input.captcha)
  if (!captchaValid) {
    return '人机验证无效, 请完成人机验证'
  }

  const ip = getRemoteIp(headers)
  const limitIP = await getKv(`limit:ip:${ip}`)
  if (limitIP) {
    return '您发送邮件的频率太快了, 请 60 秒后重试'
  }

  const user = await findUserByEmailForReset(input.email)

  if (!user) {
    await setKv(`limit:ip:${ip}`, '1', 60)
    return
  }

  const result = await sendResetPasswordLinkEmail(headers, user.id, user.email)
  if (result) {
    return result
  }
}

export const POST = kunRoute.post({
  auth: 'public',
  input: forgotPasswordRequestSchema,
  handler: async ({ req, input }) => {
    const response = await requestReset(input, req.headers)
    if (typeof response === 'string') {
      return response
    }

    return {}
  }
})
