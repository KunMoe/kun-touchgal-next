import { z } from 'zod'
import {
  kunPasswordRegex,
  kunValidMailConfirmCodeRegex
} from '~/utils/validate'
import { nonEmptyFileSchema } from './file'
import { captchaVerifyTokenSchema } from './captcha'

export const avatarSchema = z.object({
  avatar: nonEmptyFileSchema
})

export const bioSchema = z.object({
  bio: z
    .string()
    .trim()
    .min(1, { message: '您的签名最少需要 1 个字符' })
    .max(107, { message: '签名不能超过 107 个字符' })
})

export const usernameSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, { message: '您的用户名最少需要 1 个字符' })
    .max(17, { message: '用户名长度不能超过 17 个字符' })
})

export const resetEmailSchema = z.object({
  email: z.string().email({ message: '请输入合法的邮箱格式' }),
  code: z
    .string()
    .regex(kunValidMailConfirmCodeRegex, { message: '邮箱验证码格式无效' }),
  currentPassword: z.string().trim().max(1007).optional(),
  totp: z
    .string()
    .trim()
    .regex(/^$|^\d{6}$/, { message: '2FA 验证码必须为 6 位数字' })
    .optional()
})

export const sendResetEmailVerificationCodeSchema = z.object({
  email: z.string().email({ message: '请输入合法的邮箱格式' }),
  captcha: captchaVerifyTokenSchema
})

export const passwordSchema = z.object({
  oldPassword: z.string().trim().regex(kunPasswordRegex, {
    message:
      '旧密码格式非法, 密码的长度为 6 到 1007 位，必须包含至少一个英文字符和一个数字，可以选择性的包含 @!#$%^&*()_-+=\\/ 等特殊字符'
  }),
  newPassword: z.string().trim().regex(kunPasswordRegex, {
    message:
      '新密码格式非法, 密码的长度为 6 到 1007 位，必须包含至少一个英文字符和一个数字，可以选择性的包含 @!#$%^&*()_-+=\\/ 等特殊字符'
  })
})

export const getUserProfileSchema = z.object({
  id: z.coerce.number().min(1).max(9999999)
})

export const getUserInfoSchema = z.object({
  uid: z.coerce.number().min(1).max(9999999),
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(20)
})

export const searchUserSchema = z.object({
  query: z.string().min(1).max(20, { message: '非法的用户名长度' })
})

export const createFavoriteFolderSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().default(false)
})

export const updateFavoriteFolderSchema = z.object({
  folderId: z.coerce.number().min(1).max(9999999),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().default(false)
})

export const getFavoriteFolderPatchSchema = z.object({
  folderId: z.coerce.number().min(1).max(9999999),
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(100)
})

export const getUserFollowStatusSchema = z.object({
  uid: z.coerce.number({ message: '请输入合法的用户 ID' }).min(1).max(9999999),
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(100)
})

export const enableUser2FASchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { message: '2FA 验证码必须为 6 位数字' })
})

export const disableUser2FASchema = enableUser2FASchema.extend({
  isBackupCode: z.boolean().optional().default(false)
})

export const blockedTagSchema = z.object({
  tagId: z.coerce.number().min(1).max(9999999)
})

export const revokeLoginSessionSchema = z.object({
  sessionId: z.string().uuid({ message: '登录会话 ID 无效' })
})

export const allowPrivateMessageSchema = z.object({
  allowPrivateMessage: z.boolean()
})

export const enableEmailNoticeSchema = z.object({
  enableEmailNotice: z.boolean()
})
