import * as z from 'zod'
import {
  kunUsernameRegex,
  kunPasswordRegex,
  kunValidMailConfirmCodeRegex
} from '~/utils/validate'
import { isKunWhitelistedEmailDomain } from '~/constants/email/whitelist'
import { captchaVerifyTokenSchema } from './captcha'

const kunWhitelistedEmailDomainMessage =
  '暂不支持该邮箱服务商，请使用列表中的常见邮箱注册'

export const loginSchema = z.object({
  name: z
    .string()
    .trim()
    .email({ message: '请输入合法的邮箱格式, 用户名则应为 1~17 位任意字符' })
    .or(
      z.string().trim().regex(kunUsernameRegex, {
        message: '非法的用户名，用户名为 1~17 位任意字符'
      })
    ),
  password: z.string().trim().regex(kunPasswordRegex, {
    message:
      '非法的密码格式，密码的长度为 6 到 1007 位，必须包含至少一个英文字符和一个数字，可以选择性的包含 @!#$%^&*()_-+=\\/ 等特殊字符'
  }),
  captcha: captchaVerifyTokenSchema
})

export const registerSchema = z
  .object({
    name: z.string().regex(kunUsernameRegex, {
      message: '非法的用户名，用户名为 1~17 位任意字符'
    }),
    email: z.string().email({ message: '请输入合法的邮箱格式' }),
    code: z.string().regex(kunValidMailConfirmCodeRegex, {
      message: '非法的邮箱验证码，验证码为 7 位数字和大小写字母组合'
    }),
    password: z.string().trim().regex(kunPasswordRegex, {
      message:
        '非法的密码格式，密码的长度为 6 到 1007 位，必须包含至少一个英文字符和一个数字，可以选择性的包含 @!#$%^&*()_-+=\\/ 等特殊字符'
    })
  })
  .refine((data) => isKunWhitelistedEmailDomain(data.email), {
    path: ['email'],
    message: kunWhitelistedEmailDomainMessage
  })

export const sendRegisterEmailVerificationCodeSchema = z
  .object({
    name: z.string().regex(kunUsernameRegex, {
      message: '非法的用户名，用户名为 1~17 位任意字符'
    }),
    email: z.string().email({ message: '请输入合法的邮箱格式' }),
    captcha: captchaVerifyTokenSchema
  })
  .refine((data) => isKunWhitelistedEmailDomain(data.email), {
    path: ['email'],
    message: kunWhitelistedEmailDomainMessage
  })

export const disableEmailNoticeSchema = z.object({
  email: z.string().email({ message: '非法的邮箱格式' }),
  validateEmailCode: z.string().uuid({ message: '非法的邮箱验证码格式' })
})

export const verifyLogin2FASchema = z.object({
  token: z.string().regex(/^\d{6}$/, { message: '2FA 验证码必须为 6 位数字' }),
  isBackupCode: z.boolean().optional().default(false)
})
