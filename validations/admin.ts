import * as z from 'zod'
import {
  ADMIN_COMMENT_DELETE_LIMIT,
  ADMIN_RATING_DELETE_LIMIT,
  ADMIN_RESOURCE_DELETE_LIMIT
} from '~/constants/admin'
import { MODERATION_TEXT_CONTENT_TYPE } from '~/constants/moderation'
import { kunPasswordRegex } from '~/utils/validate'

export const adminReportTargetTypeSchema = z.enum(['comment', 'rating'])

export const adminPaginationSchema = z.object({
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(100),
  search: z
    .string()
    .max(300, { message: '搜索关键词不能超过 300 个字符' })
    .optional()
})

export const adminUserSearchTypeSchema = z.enum(['name', 'email', 'id'])

export const adminUserPaginationSchema = adminPaginationSchema.extend({
  limit: z.coerce.number().min(1).max(500),
  searchType: adminUserSearchTypeSchema.default('name')
})

export const adminCommentSearchTypeSchema = z.enum(['content', 'user'])

export const adminCommentPaginationSchema = adminPaginationSchema.extend({
  limit: z.coerce.number().min(1).max(500),
  searchType: adminCommentSearchTypeSchema.default('content'),
  userId: z.coerce.number().min(1).max(9999999).optional()
})

const adminCommentIdsSchema = z
  .string()
  .trim()
  .min(1, { message: '至少选择一条评论' })
  .refine(
    (value) =>
      value.split(',').every((item) => {
        const trimmed = item.trim()
        if (!/^\d+$/.test(trimmed)) {
          return false
        }

        const commentId = Number.parseInt(trimmed, 10)
        return commentId >= 1 && commentId <= 9999999
      }),
    { message: '评论 ID 格式不正确' }
  )
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((commentId) => commentId >= 1 && commentId <= 9999999)
    )
  ])
  .refine((commentIds) => commentIds.length <= ADMIN_COMMENT_DELETE_LIMIT, {
    message: `单次最多删除 ${ADMIN_COMMENT_DELETE_LIMIT} 条评论`
  })

export const adminDeleteCommentSchema = z.union([
  z
    .object({
      commentId: z.coerce
        .number({ message: '评论 ID 必须为数字' })
        .min(1)
        .max(9999999)
    })
    .transform(({ commentId }) => ({
      commentIds: [commentId]
    })),
  z
    .object({
      commentIds: adminCommentIdsSchema
    })
    .transform(({ commentIds }) => ({
      commentIds
    }))
])

export const adminGalgamePaginationSchema = adminPaginationSchema.extend({
  limit: z.coerce.number().min(1).max(500)
})

export const adminFeedbackPaginationSchema = adminPaginationSchema.extend({
  limit: z.coerce.number().min(1).max(500)
})

export const adminResourceApplyPaginationSchema = adminPaginationSchema.extend({
  limit: z.coerce.number().min(1).max(500)
})

export const adminResourceSearchTypeSchema = z.enum(['content', 'info'])

export const adminResourcePaginationSchema = adminPaginationSchema.extend({
  limit: z.coerce.number().min(1).max(500),
  searchType: adminResourceSearchTypeSchema.default('content'),
  userId: z.coerce.number().min(1).max(9999999).optional()
})

const adminResourceHiddenLimit = 500

// 逗号分隔的资源 id 列表 → 去重 int[]; 上限由各端点自行 refine (隐藏 500 / 删除 100)
const adminResourceIdListSchema = z
  .string()
  .trim()
  .min(1, { message: '至少选择一条资源' })
  .refine(
    (value) =>
      value.split(',').every((item) => {
        const trimmed = item.trim()
        if (!/^\d+$/.test(trimmed)) {
          return false
        }

        const resourceId = Number.parseInt(trimmed, 10)
        return resourceId >= 1 && resourceId <= 9999999
      }),
    { message: '资源 ID 格式不正确' }
  )
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((resourceId) => resourceId >= 1 && resourceId <= 9999999)
    )
  ])

const adminResourceIdsSchema = adminResourceIdListSchema.refine(
  (resourceIds) => resourceIds.length <= adminResourceHiddenLimit,
  { message: `单次最多操作 ${adminResourceHiddenLimit} 条资源` }
)

const adminDeleteResourceIdsSchema = adminResourceIdListSchema.refine(
  (resourceIds) => resourceIds.length <= ADMIN_RESOURCE_DELETE_LIMIT,
  { message: `单次最多删除 ${ADMIN_RESOURCE_DELETE_LIMIT} 条资源` }
)

// 单条 resourceId 与批量 resourceIds 共用一个 DELETE 端点, 统一归一为 resourceIds
export const adminDeleteResourceSchema = z.union([
  z
    .object({
      resourceId: z.coerce
        .number({ message: '资源 ID 必须为数字' })
        .int()
        .min(1)
        .max(9999999)
    })
    .transform(({ resourceId }) => ({
      resourceIds: [resourceId]
    })),
  z
    .object({
      resourceIds: adminDeleteResourceIdsSchema
    })
    .transform(({ resourceIds }) => ({
      resourceIds
    }))
])

// 0 - 正常, 1 - 隐藏 (仅后台可见)
// 待初次审核 (2) / 待审核 (3) 为系统态, 不可通过此接口设置
export const adminUpdateResourceHiddenSchema = z.object({
  resourceIds: adminResourceIdsSchema,
  status: z.union([z.literal(0), z.literal(1)])
})

export const adminReportPaginationSchema = adminPaginationSchema.extend({
  tab: z.enum(['pending', 'handled']).default('pending'),
  targetType: adminReportTargetTypeSchema.default('comment')
})

export const adminUpdateUserSchema = z.object({
  uid: z.coerce.number().min(1).max(9999999),
  name: z
    .string()
    .trim()
    .min(1, { message: '用户名长度至少为 1 个字符' })
    .max(17, { message: '用户名长度不能超过 17 个字符' }),
  email: z.string().trim().email({ message: '请输入合法的邮箱格式' }),
  role: z.coerce.number().min(1).max(3),
  status: z.coerce.number().min(0).max(2),
  dailyImageCount: z.coerce.number().min(0).max(50),
  moemoepoint: z.coerce
    .number()
    .int({ message: '萌萌点必须为整数' })
    .min(0)
    .max(9999999),
  password: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return value
      }

      const trimmedValue = value.trim()
      return trimmedValue ? trimmedValue : undefined
    },
    z
      .string()
      .regex(kunPasswordRegex, {
        message:
          '新密码格式非法, 密码长度需为 6 到 1007 位, 且至少包含一个英文字符和一个数字'
      })
      .optional()
  ),
  bio: z.string().trim().max(107, { message: '个人简介不能超过 107 个字符' })
})

export const adminDisableUser2FASchema = z.object({
  uid: z.coerce.number({ message: '用户 ID 必须为数字' }).min(1).max(9999999)
})

export const approveCreatorSchema = z.object({
  messageId: z.coerce.number().min(1).max(9999999),
  uid: z.coerce.number().min(1).max(9999999)
})

export const declineCreatorSchema = z.object({
  messageId: z.coerce.number().min(1).max(9999999),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1007, { message: '拒绝原因不能超过 1007 个字符' })
})

export const adminSendEmailSchema = z.object({
  templateId: z.string(),
  variables: z.record(z.string(), z.string())
})

export const adminHandleFeedbackSchema = z.object({
  messageId: z.coerce.number().min(1).max(9999999),
  content: z
    .string()
    .trim()
    .max(5000, { message: '回复内容不能超过 5000 个字符' })
})

export const adminRatingSearchTypeSchema = z.enum(['content', 'user'])

export const adminRatingPaginationSchema = adminPaginationSchema.extend({
  limit: z.coerce.number().min(1).max(500),
  searchType: adminRatingSearchTypeSchema.default('content'),
  userId: z.coerce.number().min(1).max(9999999).optional()
})

const adminRatingIdsSchema = z
  .string()
  .trim()
  .min(1, { message: '至少选择一条评价' })
  .refine(
    (value) =>
      value.split(',').every((item) => {
        const trimmed = item.trim()
        if (!/^\d+$/.test(trimmed)) {
          return false
        }

        const ratingId = Number.parseInt(trimmed, 10)
        return ratingId >= 1 && ratingId <= 9999999
      }),
    { message: '评价 ID 格式不正确' }
  )
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((ratingId) => ratingId >= 1 && ratingId <= 9999999)
    )
  ])
  .refine((ratingIds) => ratingIds.length <= ADMIN_RATING_DELETE_LIMIT, {
    message: `单次最多删除 ${ADMIN_RATING_DELETE_LIMIT} 条评价`
  })

export const adminDeleteRatingSchema = z.union([
  z
    .object({
      ratingId: z.coerce
        .number({ message: '评价 ID 必须为数字' })
        .min(1)
        .max(9999999)
    })
    .transform(({ ratingId }) => ({
      ratingIds: [ratingId]
    })),
  z
    .object({
      ratingIds: adminRatingIdsSchema
    })
    .transform(({ ratingIds }) => ({
      ratingIds
    }))
])

export const patchRatingUpdateSchema = z.object({
  ratingId: z.coerce.number().min(1).max(9999999),
  shortSummary: z
    .string()
    .trim()
    .min(1, { message: '评价内容不可为空' })
    .max(1314, { message: '评价内容不能超过 1314 个字符' })
})

export const adminHandleReportSchema = z.object({
  reportId: z.coerce.number().min(1).max(9999999),
  action: z.enum(['delete', 'reject']),
  content: z
    .string()
    .trim()
    .max(5000, { message: '处理结果不能超过 5000 个字符' })
})

// 上限与列表每页最大条数一致 (100): 全选当前页即为单次批量的最大规模
export const adminBatchHandleReportSchema = z.object({
  reportIds: z.array(z.coerce.number().min(1).max(9999999)).min(1).max(100),
  action: z.enum(['delete', 'reject']),
  content: z
    .string()
    .trim()
    .max(5000, { message: '处理结果不能超过 5000 个字符' })
})

export const approvePatchResourceSchema = z.object({
  resourceId: z.coerce.number().min(1).max(9999999)
})

export const declinePatchResourceSchema = z.object({
  resourceId: z.coerce.number().min(1).max(9999999),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1007, { message: '拒绝原因不能超过 1007 个字符' })
})

export const adminUpdateRedirectSchema = z.object({
  enableRedirect: z.coerce.boolean(),
  excludedDomains: z.array(
    z.string().max(500, { message: '单个域名不能超过 500 个字符' })
  ),
  delaySeconds: z.coerce
    .number()
    .min(0, { message: '跳转延时不能为负数' })
    .max(60, { message: '跳转延时不能超过 60 秒' })
})

export const adminUpdateDisableRegisterSchema = z.object({
  disableRegister: z.boolean()
})

export const adminUpdateModerationSettingSchema = z.object({
  enabled: z.boolean(),
  dryRun: z.boolean()
})

export const adminModerationPaginationSchema = adminPaginationSchema.extend({
  status: z
    .enum(['all', 'pending', 'approved', 'rejected', 'manual', 'superseded'])
    .default('all')
})

export const adminModerationReviewSchema = z.object({
  taskId: z.coerce.number().min(1).max(9999999),
  approve: z.boolean()
})

export const adminModerationRetrySchema = z.object({
  taskId: z.coerce.number().min(1).max(9999999)
})

// 上限与列表每页条数一致: 全选当前页即为单次批量的最大规模
export const adminModerationBatchSchema = z.object({
  taskIds: z.array(z.coerce.number().min(1).max(9999999)).min(1).max(30),
  action: z.enum(['approve', 'reject', 'retry'])
})

export const adminModerationBlacklistCreateSchema = z.object({
  pattern: z
    .string()
    .trim()
    .min(2, { message: '黑名单模式至少 2 个字符' })
    .max(1007, { message: '黑名单模式最多 1007 个字符' }),
  // 空数组 = 对全部文本类型生效
  contentTypes: z
    .array(z.enum(MODERATION_TEXT_CONTENT_TYPE))
    .max(MODERATION_TEXT_CONTENT_TYPE.length)
    .default([])
})

export const adminModerationBlacklistDeleteSchema = z.object({
  blacklistId: z.coerce.number().min(1).max(9999999)
})

export const adminAppealPaginationSchema = adminPaginationSchema.extend({
  status: z.enum(['all', 'pending', 'approved', 'rejected']).default('pending')
})

export const adminHandleAppealSchema = z.object({
  appealId: z.coerce.number().min(1).max(9999999),
  approve: z.boolean()
})

// admin 仅在正常 (0) 与隐藏 (2) 间切换; 待审核 (1) 为系统态, 不手动设置
export const adminUpdateCommentShadowBanSchema = z.object({
  commentId: z.coerce.number().min(1).max(9999999),
  status: z.union([z.literal(0), z.literal(2)])
})

export const adminUpdateRatingShadowBanSchema = z.object({
  ratingId: z.coerce.number().min(1).max(9999999),
  status: z.union([z.literal(0), z.literal(2)])
})

export const adminGetFullCommentSchema = z.object({
  commentId: z.coerce.number().min(1).max(9999999)
})

export const adminGetFullRatingSchema = z.object({
  ratingId: z.coerce.number().min(1).max(9999999)
})
