import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { sendVerificationCodeEmail } from '~/app/api/utils/sendVerificationCodeEmail'
import { sendResetEmailVerificationCodeSchema } from '~/validations/user'
import { checkKunCaptchaExist } from '~/app/api/utils/verifyKunCaptcha'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import type { NextRequest } from 'next/server'

const sendCode = async (
  req: NextRequest,
  input: z.infer<typeof sendResetEmailVerificationCodeSchema>
) => {
  if (!getRemoteIp(req.headers)) {
    return '读取请求头失败'
  }

  const res = await checkKunCaptchaExist(input.captcha)
  if (!res) {
    return '人机验证无效, 请完成人机验证'
  }

  const result = await sendVerificationCodeEmail(
    req.headers,
    input.email,
    'reset'
  )
  if (result) {
    return result
  }
}

export const POST = kunRoute.post({
  auth: 'user',
  input: sendResetEmailVerificationCodeSchema,
  handler: async ({ req, input }) => {
    const res = await sendCode(req, input)
    return typeof res === 'string' ? res : {}
  }
})
