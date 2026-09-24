import * as z from 'zod'
import { kunCaptchaVerifyTokenRegex } from '~/constants/captcha'

export const captchaVerifyTokenSchema = z
  .string()
  .trim()
  .regex(kunCaptchaVerifyTokenRegex, { message: '非法的人机验证码格式' })

export const capRedeemSchema = z.object({
  token: z
    .string()
    .min(1, { message: '非法的挑战令牌' })
    .max(4096, { message: '非法的挑战令牌' }),
  solutions: z
    .array(z.number(), { message: '非法的挑战答案格式' })
    .max(128, { message: '非法的挑战答案格式' })
})
