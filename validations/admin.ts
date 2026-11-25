import * as z from 'zod'
import { kunId, kunInt, kunLimit, kunNumber, kunPage } from './primitives'
import { INT4_MAX } from '~/constants/db-limits'
import {
  ADMIN_COMMENT_DELETE_LIMIT,
  ADMIN_RATING_DELETE_LIMIT,
  ADMIN_RESOURCE_DELETE_LIMIT,
  MAIL_CAMPAIGN_CONTENT_LIMIT,
  MAIL_CAMPAIGN_TITLE_LIMIT
} from '~/constants/admin'
import { CAMPAIGN_TEMPLATE_IDS } from '~/constants/email/campaign'
import { isWellFormedText } from '~/utils/text/unicode'
import {
  MODERATION_FAILURE_KIND,
  MODERATION_TEXT_CONTENT_TYPE
} from '~/constants/moderation'
import { kunPasswordRegex } from '~/utils/validate'
import { KUN_ROLE } from '~/constants/role'
import {
  COMMENT_STATUS,
  RATING_STATUS,
  RESOURCE_STATUS
} from '~/constants/contentStatus'

export const adminReportTargetTypeSchema = z.enum(['comment', 'rating'])

export const adminPaginationSchema = z.object({
  page: kunPage(),
  limit: kunLimit(100),
  search: z
    .string()
    .max(300, { message: '搜索关键词不能超过 300 个字符' })
    .optional()
})

export const adminUserSearchTypeSchema = z.enum(['name', 'email', 'id'])

export const adminUserPaginationSchema = adminPaginationSchema.extend({
  limit: kunLimit(500),
  searchType: adminUserSearchTypeSchema.default('name')
})

export const adminCommentSearchTypeSchema = z.enum(['content', 'user'])

export const adminCommentPaginationSchema = adminPaginationSchema.extend({
  limit: kunLimit(500),
  searchType: adminCommentSearchTypeSchema.default('content'),
  userId: kunId('用户 ID').optional()
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
        return commentId >= 1 && commentId <= INT4_MAX
      }),
    { message: '评论 ID 格式不正确' }
  )
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((commentId) => commentId >= 1 && commentId <= INT4_MAX)
    )
  ])
  .refine((commentIds) => commentIds.length <= ADMIN_COMMENT_DELETE_LIMIT, {
    message: `单次最多删除 ${ADMIN_COMMENT_DELETE_LIMIT} 条评论`
  })

export const adminDeleteCommentSchema = z.union([
  z
    .object({
      commentId: kunId('评论 ID')
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
  limit: kunLimit(500)
})

export const adminFeedbackPaginationSchema = adminPaginationSchema.extend({
  limit: kunLimit(500)
})

export const adminResourceApplyPaginationSchema = adminPaginationSchema.extend({
  limit: kunLimit(500)
})

export const adminResourceSearchTypeSchema = z.enum(['content', 'info'])

export const adminResourcePaginationSchema = adminPaginationSchema.extend({
  limit: kunLimit(500),
  searchType: adminResourceSearchTypeSchema.default('content'),
  userId: kunId('用户 ID').optional()
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
        return resourceId >= 1 && resourceId <= INT4_MAX
      }),
    { message: '资源 ID 格式不正确' }
  )
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((resourceId) => resourceId >= 1 && resourceId <= INT4_MAX)
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
      resourceId: kunId('资源 ID')
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
  // 只在公开与隐藏之间切换: 入口据此选迁移 (utils/content/transitions.ts 的 hide / unhide)
  status: z.union([
    z.literal(RESOURCE_STATUS.public),
    z.literal(RESOURCE_STATUS.hidden)
  ])
})

export const adminReportPaginationSchema = adminPaginationSchema.extend({
  tab: z.enum(['pending', 'handled']).default('pending'),
  targetType: adminReportTargetTypeSchema.default('comment')
})

// 后台改用户是合并契约: 请求只带这一次改了的字段 (客户端由 kunAdminUserChanges 与列表里这一行
// 比出来), 没带的列不写。列表加载之后别处写下的改名、改邮箱、升权、封禁、萌萌点与图片计数
// 因此不会被回滚, 只属于某一列的规则也只在改这一列时才拦。计数列只收差值或清零, 不收绝对值。
// strict: 旧页面的整行请求体 (带着已删掉的 dailyImageCount) 整个拒绝, 不会剥掉未知键之后接着
// 用快照覆盖其余的列
export const adminPatchUserSchema = z
  .strictObject(
    {
      uid: kunId('用户 ID'),
      name: z
        .string()
        .trim()
        .min(1, { message: '用户名长度至少为 1 个字符' })
        .max(17, { message: '用户名长度不能超过 17 个字符' })
        .optional(),
      email: z
        .string()
        .trim()
        .email({ message: '请输入合法的邮箱格式' })
        .optional(),
      // 只校验取值域, 能不能改成这个角色由服务按新旧角色判定 (canAssignRole)
      role: kunInt(
        KUN_ROLE.USER,
        KUN_ROLE.SUPER_ADMIN,
        '用户角色无效'
      ).optional(),
      status: kunInt(0, 2, '用户状态无效').optional(),
      // 萌萌点按差值调整 (表单里仍填目标值, 由客户端换算), 列表加载之后发生的增减不会被覆盖
      moemoepointDelta: kunInt(
        -9999999,
        9999999,
        '萌萌点调整值须为 -9999999～9999999 的整数'
      )
        .refine((delta) => delta !== 0, { message: '萌萌点调整值不能为 0' })
        .optional(),
      // 当日已用图片数只能清零: 它另有抢占、退还与每日重置三个写者
      resetDailyImageCount: z
        .literal(true, { message: '清零图片计数的参数无效' })
        .optional(),
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
      bio: z
        .string()
        .trim()
        .max(107, { message: '个人简介不能超过 107 个字符' })
        .optional()
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys'
          ? '页面版本已过期, 请刷新后重试'
          : undefined
    }
  )
  .refine(
    (input) =>
      Object.entries(input).some(
        ([key, value]) => key !== 'uid' && value !== undefined
      ),
    {
      message: '没有需要保存的修改',
      // 旧页面的请求体只报「页面版本已过期」: 未知键不中止解析, 不加这一句会再多报一条
      when: (payload) => payload.issues.length === 0
    }
  )

export const adminDisableUser2FASchema = z.object({
  uid: kunId('用户 ID')
})

export const approveCreatorSchema = z.object({
  messageId: kunId('消息 ID'),
  uid: kunId('用户 ID')
})

export const declineCreatorSchema = z.object({
  messageId: kunId('消息 ID'),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1007, { message: '拒绝原因不能超过 1007 个字符' })
})

// 标题与正文是超级管理员写的受信 HTML (constants/email/campaign.ts), 这里只管模板存在、
// 两者非空且不超长
export const adminSendEmailSchema = z.object({
  templateId: z.enum(CAMPAIGN_TEMPLATE_IDS, { message: '未知的邮件模板' }),
  variables: z.object({
    title: z
      .string()
      .trim()
      .min(1, { message: '邮件标题不能为空' })
      .max(MAIL_CAMPAIGN_TITLE_LIMIT, {
        message: `邮件标题不能超过 ${MAIL_CAMPAIGN_TITLE_LIMIT} 个字符`
      })
      // NUL 写不进库 (PG 报 22021), 在这里拒绝而不是让它变成 500
      .refine(isWellFormedText, { message: '邮件标题含有无法保存的字符' }),
    content: z
      .string()
      .trim()
      .min(1, { message: '邮件内容不能为空' })
      .max(MAIL_CAMPAIGN_CONTENT_LIMIT, {
        message: `邮件内容不能超过 ${MAIL_CAMPAIGN_CONTENT_LIMIT} 个字符`
      })
      .refine(isWellFormedText, { message: '邮件内容含有无法保存的字符' })
  })
})

export const adminMailCampaignActionSchema = z.object({
  campaignId: kunId('群发任务 ID'),
  action: z.enum(['cancel', 'resume'])
})

export const adminHandleFeedbackSchema = z.object({
  messageId: kunId('消息 ID'),
  content: z
    .string()
    .trim()
    .max(5000, { message: '回复内容不能超过 5000 个字符' })
})

export const adminRatingSearchTypeSchema = z.enum(['content', 'user'])

export const adminRatingPaginationSchema = adminPaginationSchema.extend({
  limit: kunLimit(500),
  searchType: adminRatingSearchTypeSchema.default('content'),
  userId: kunId('用户 ID').optional()
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
        return ratingId >= 1 && ratingId <= INT4_MAX
      }),
    { message: '评价 ID 格式不正确' }
  )
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((ratingId) => ratingId >= 1 && ratingId <= INT4_MAX)
    )
  ])
  .refine((ratingIds) => ratingIds.length <= ADMIN_RATING_DELETE_LIMIT, {
    message: `单次最多删除 ${ADMIN_RATING_DELETE_LIMIT} 条评价`
  })

export const adminDeleteRatingSchema = z.union([
  z
    .object({
      ratingId: kunId('评价 ID')
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
  ratingId: kunId('评价 ID'),
  shortSummary: z
    .string()
    .trim()
    .min(1, { message: '评价内容不可为空' })
    .max(1314, { message: '评价内容不能超过 1314 个字符' })
})

export const adminHandleReportSchema = z.object({
  reportId: kunId('举报 ID'),
  action: z.enum(['delete', 'reject']),
  content: z
    .string()
    .trim()
    .max(5000, { message: '处理结果不能超过 5000 个字符' })
})

// 上限与列表每页最大条数一致 (100): 全选当前页即为单次批量的最大规模
export const adminBatchHandleReportSchema = z.object({
  reportIds: z.array(kunId('举报 ID')).min(1).max(100),
  action: z.enum(['delete', 'reject']),
  content: z
    .string()
    .trim()
    .max(5000, { message: '处理结果不能超过 5000 个字符' })
})

export const approvePatchResourceSchema = z.object({
  resourceId: kunId('资源 ID')
})

export const declinePatchResourceSchema = z.object({
  resourceId: kunId('资源 ID'),
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
  delaySeconds: kunNumber(0, 60, '跳转延时须为 0～60 秒')
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
    .default('all'),
  // 按最近一次失败的类别筛选 (转人工的原因、待审核任务卡在哪一类失败上)
  failureKind: z.enum(['all', ...MODERATION_FAILURE_KIND]).default('all')
})

export const adminModerationReviewSchema = z.object({
  taskId: kunId('审核任务 ID'),
  approve: z.boolean()
})

export const adminModerationRetrySchema = z.object({
  taskId: kunId('审核任务 ID')
})

// 上限与列表每页条数一致: 全选当前页即为单次批量的最大规模
export const adminModerationBatchSchema = z.object({
  taskIds: z.array(kunId('审核任务 ID')).min(1).max(30),
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
  blacklistId: kunId('黑名单 ID')
})

export const adminAppealPaginationSchema = adminPaginationSchema.extend({
  status: z.enum(['all', 'pending', 'approved', 'rejected']).default('pending')
})

export const adminHandleAppealSchema = z.object({
  appealId: kunId('申诉 ID'),
  approve: z.boolean()
})

// admin 仅在正常 (0) 与隐藏 (2) 间切换; 待审核 (1) 为系统态, 不手动设置
export const adminUpdateCommentShadowBanSchema = z.object({
  commentId: kunId('评论 ID'),
  status: z.union([
    z.literal(COMMENT_STATUS.public),
    z.literal(COMMENT_STATUS.hidden)
  ])
})

export const adminUpdateRatingShadowBanSchema = z.object({
  ratingId: kunId('评价 ID'),
  status: z.union([
    z.literal(RATING_STATUS.public),
    z.literal(RATING_STATUS.hidden)
  ])
})

export const adminGetFullCommentSchema = z.object({
  commentId: kunId('评论 ID')
})

export const adminGetFullRatingSchema = z.object({
  ratingId: kunId('评价 ID')
})
