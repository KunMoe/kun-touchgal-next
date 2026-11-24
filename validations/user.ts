import * as z from 'zod'
import { kunId, kunLimit, kunPage } from './primitives'
import {
  kunPasswordRegex,
  kunValidMailConfirmCodeRegex
} from '~/utils/validate'
import { nonEmptyFileSchema } from './file'
import { captchaVerifyTokenSchema } from './captcha'
import {
  kunTotpCodeMessage,
  optionalBackupCodeSchema,
  optionalTotpCodeSchema,
  secondFactorCodeSchema
} from './secondFactor'

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

// 敏感操作的二次验证 (server/auth/stepUp.ts)。这里只管形状: 每种操作要哪些因子由那边的
// 策略表决定, 缺了由 requireStepUp 报「请输入…」, 所以三项都可选
export const stepUpProofSchema = z.object({
  currentPassword: z.string().trim().max(1007).optional(),
  totp: optionalTotpCodeSchema,
  backupCode: optionalBackupCodeSchema
})

export const resetEmailSchema = z
  .object({
    email: z.string().email({ message: '请输入合法的邮箱格式' }),
    code: z
      .string()
      .regex(kunValidMailConfirmCodeRegex, { message: '邮箱验证码格式无效' })
  })
  .extend(stepUpProofSchema.shape)

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

// 只有一个 uid 的入参 (关注、取消关注、悬浮卡片、后台删号) 共用这一份
export const userUidSchema = z.object({
  uid: kunId('用户 ID')
})

export const getUserProfileSchema = z.object({
  id: kunId('用户 ID')
})

export const getUserInfoSchema = z.object({
  uid: kunId('用户 ID'),
  page: kunPage(),
  limit: kunLimit(20)
})

export const searchUserSchema = z.object({
  query: z.string().min(1).max(20, { message: '非法的用户名长度' })
})

export const createFavoriteFolderSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().default(false)
})

export const favoriteFolderIdSchema = z.object({
  folderId: kunId('收藏文件夹 ID')
})

// 带 patchId 时附上每个收藏夹是否已收藏该作品; page 与 limit 同时给才分页
export const getFavoriteFoldersSchema = z.object({
  patchId: kunId('游戏 ID').optional(),
  page: kunPage().optional(),
  limit: kunLimit(100).optional()
})

export const updateFavoriteFolderSchema = z.object({
  folderId: kunId('收藏文件夹 ID'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().default(false)
})

export const getFavoriteFolderPatchSchema = z.object({
  folderId: kunId('收藏文件夹 ID'),
  page: kunPage(),
  limit: kunLimit(100)
})

export const getUserFollowStatusSchema = z.object({
  uid: kunId('用户 ID'),
  page: kunPage(),
  limit: kunLimit(100)
})

export const enableUser2FASchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { message: kunTotpCodeMessage })
})

export const disableUser2FASchema = secondFactorCodeSchema

// 还没刷新的旧页面不带请求体: 回一句人话, 而不是 zod 的类型错误
export const beginTwoFactorEnrollmentSchema = z.object(
  { currentPassword: stepUpProofSchema.shape.currentPassword },
  { message: '请输入当前密码' }
)

export const blockedTagSchema = z.object({
  tagId: kunId('标签 ID')
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
