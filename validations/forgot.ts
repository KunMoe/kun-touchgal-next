import * as z from 'zod'
import { kunPasswordRegex } from '~/utils/validate'
import { captchaVerifyTokenSchema } from './captcha'

export const forgotPasswordRequestSchema = z.object({
  email: z.string().trim().email({ message: '请输入合法的邮箱格式' }),
  captcha: captchaVerifyTokenSchema
})

export const forgotPasswordResetSchema = z.object({
  token: z.string().trim().uuid({ message: '重置链接无效' }),
  newPassword: z.string().regex(kunPasswordRegex, {
    message:
      '新密码格式错误, 密码的长度为 6 到 107 位，必须包含至少一个英文字符和一个数字，可以选择性的包含 @!#$%^&*()_-+=\\/ 等特殊字符'
  }),
  confirmPassword: z.string().regex(kunPasswordRegex, {
    message:
      '确认密码格式错误, 密码的长度为 6 到 107 位，必须包含至少一个英文字符和一个数字，可以选择性的包含 @!#$%^&*()_-+=\\/ 等特殊字符'
  })
})
