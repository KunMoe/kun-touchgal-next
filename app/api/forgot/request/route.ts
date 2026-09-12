import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { forgotPasswordRequestSchema } from '~/validations/forgot'
import { prisma } from '~/prisma/index'
import { sendResetPasswordLinkEmail } from '~/app/api/utils/sendResetPasswordLinkEmail'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { insensitiveEquals } from '~/app/api/utils/insensitiveEquals'
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

  const user = await prisma.user.findFirst({
    where: { email: insensitiveEquals(input.email) }
  })

  if (!user) {
    await setKv(`limit:ip:${ip}`, '1', 60)
    return
  }

  const result = await sendResetPasswordLinkEmail(headers, user.id, user.email)
  if (result) {
    return result
  }
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, forgotPasswordRequestSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const response = await requestReset(input, req.headers)
  if (typeof response === 'string') {
    return NextResponse.json(response)
  }

  return NextResponse.json({})
}
