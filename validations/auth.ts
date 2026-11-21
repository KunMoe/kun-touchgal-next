import * as z from 'zod'
import {
  kunUsernameRegex,
  kunPasswordRegex,
  kunValidMailConfirmCodeRegex
} from '~/utils/validate'
import { isKunWhitelistedEmailDomain } from '~/constants/email/whitelist'
import { captchaVerifyTokenSchema } from './captcha'
import { secondFactorCodeSchema } from './secondFactor'

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

const kunUnsubscribeLinkInvalidMessage =
  '退订链接无效, 请您登录后在用户设置页面取消邮件订阅'

// 退订链接带的参数。前一种是现行的: 用户 id 加对它的签名 (server/mail/unsubscribeToken.ts);
// 后一种是改用签名之前发出的邮件里的邮箱加一次性验证码, 那些链接七天内有效。
// 前一种的每条检查都自带文案: 只有一个分支「类型对、取值不对」时 zod 直接回那个分支的
// 问题, 不用 union 上的文案
export const disableEmailNoticeSchema = z.union(
  [
    z.object({
      uid: z.coerce
        .number()
        .int({ message: kunUnsubscribeLinkInvalidMessage })
        .min(1, { message: kunUnsubscribeLinkInvalidMessage })
        .max(2147483647, { message: kunUnsubscribeLinkInvalidMessage }),
      token: z
        .string()
        .length(32, { message: kunUnsubscribeLinkInvalidMessage })
    }),
    z.object({
      email: z.string().email({ message: '非法的邮箱格式' }),
      validateEmailCode: z.string().uuid({ message: '非法的邮箱验证码格式' })
    })
  ],
  { message: kunUnsubscribeLinkInvalidMessage }
)

export const verifyLogin2FASchema = secondFactorCodeSchema
