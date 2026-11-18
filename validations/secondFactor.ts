import * as z from 'zod'

// 身份验证器的验证码恒为 6 位。备用验证码存量是 6 位, 之后发的是 10 位, 两种都收
export const kunTotpCodeMessage = '2FA 验证码必须为 6 位数字'
export const kunBackupCodeMessage = '备用验证码必须为 6 位或 10 位数字'

const totpCodeRegex = /^\d{6}$/
const backupCodeRegex = /^(\d{6}|\d{10})$/

// 表单把没填的项提交成空串, 空串按没填处理
export const optionalTotpCodeSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || totpCodeRegex.test(value), {
    message: kunTotpCodeMessage
  })
  .optional()

export const optionalBackupCodeSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || backupCodeRegex.test(value), {
    message: kunBackupCodeMessage
  })
  .optional()

// 登录第二步与关闭 2FA 共用的形状: 一个输入框, 由 isBackupCode 说明填的是哪种码
export const secondFactorCodeSchema = z
  .object({
    token: z.string().trim(),
    isBackupCode: z.boolean().optional().default(false)
  })
  .superRefine(({ token, isBackupCode }, ctx) => {
    const regex = isBackupCode ? backupCodeRegex : totpCodeRegex
    if (!regex.test(token)) {
      ctx.addIssue({
        code: 'custom',
        path: ['token'],
        message: isBackupCode ? kunBackupCodeMessage : kunTotpCodeMessage
      })
    }
  })
