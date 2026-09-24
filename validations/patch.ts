import * as z from 'zod'
import { ResourceSizeRegex } from '~/utils/validate'
import { nonEmptyFileSchema } from './file'
import {
  RESOURCE_SECTION_TYPE_MAP,
  SUPPORTED_TYPE,
  SUPPORTED_LANGUAGE,
  SUPPORTED_PLATFORM,
  SUPPORTED_EMULATOR_TYPE,
  SUPPORTED_RESOURCE_LINK,
  SUPPORTED_RESOURCE_SECTION
} from '~/constants/resource'
import {
  KUN_GALGAME_RATING_RECOMMEND_CONST,
  KUN_GALGAME_RATING_SPOILER_CONST,
  KUN_GALGAME_RATING_PLAY_STATUS_CONST
} from '~/constants/galgame'

export const patchTagChangeSchema = z.object({
  patchId: z.coerce.number({ message: 'ID 必须为数字' }).min(1).max(9999999),
  tagId: z
    .array(
      z.coerce.number({ message: '标签 ID 必须为数字' }).min(1).max(9999999)
    )
    .min(1)
    .max(107, { message: '一个 Galgame 最多有 107 个标签' })
})

export const patchCompanyChangeSchema = z.object({
  patchId: z.coerce
    .number({ message: 'Galgame ID 必须为数字' })
    .min(1)
    .max(9999999),
  companyId: z
    .array(
      z.coerce.number({ message: '会社 ID 必须为数字' }).min(1).max(9999999)
    )
    .min(1)
    .max(107, { message: '一个 Galgame 最多有 107 个会社' })
})

export const patchCommentCreateSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999),
  parentId: z.coerce.number().min(1).max(9999999).nullable(),
  resourceId: z.coerce.number().min(1).max(9999999).optional(),
  content: z
    .string()
    .trim()
    .min(1, { message: '评论的内容最少为 1 个字符' })
    .max(10007, { message: '评论的内容最多为 10007 个字符' }),
  isSpoiler: z.boolean().optional().default(false)
})

export const patchCommentUpdateSchema = z.object({
  commentId: z.coerce.number().min(1).max(9999999),
  content: z
    .string()
    .trim()
    .min(1, { message: '评论的内容最少为 1 个字符' })
    .max(10007, { message: '评论的内容最多为 10007 个字符' }),
  isSpoiler: z.boolean().optional().default(false)
})

export const getPatchCommentSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999),
  resourceId: z.coerce.number().min(1).max(9999999).optional(),
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(50),
  commentId: z.coerce.number().min(1).max(9999999).optional()
})

// section 与 type 的联动约束: 所选类型必须属于对应资源类别下允许的类型;
// 另有 platform/type 触发的条件必填: 模拟器平台须选模拟器类型, AI 补丁须填模型型号
const refineResourceSectionType = (
  data: {
    section: string
    type: string[]
    platform: string[]
    emulatorType: string[]
    modelName: string
  },
  ctx: z.RefinementCtx
) => {
  const allowedTypes = RESOURCE_SECTION_TYPE_MAP[data.section]
  if (allowedTypes && !data.type.every((t) => allowedTypes.includes(t))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '所选资源类型不属于当前资源类别',
      path: ['type']
    })
  }
  if (data.platform.includes('emulator') && data.emulatorType.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '选择模拟器平台时请选择模拟器类型',
      path: ['emulatorType']
    })
  }
  if (data.type.includes('ai') && !data.modelName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '发布 AI 翻译补丁时请填写模型型号',
      path: ['modelName']
    })
  }
}

const patchResourceBaseSchema = z.object({
  // <number> 仅标注 input 类型, 使表单 (zodResolver) 与 API 复用同一 schema 时类型对齐
  patchId: z.coerce.number<number>().min(1).max(9999999),
  section: z
    .string()
    .refine((type) => SUPPORTED_RESOURCE_SECTION.includes(type), {
      message: '资源链接类型仅能为 Galgame 或补丁'
    }),
  name: z.string().max(300, { message: '资源名称最多 300 个字符' }),
  note: z.string().max(10007, { message: '资源备注最多 10007 字' }),
  links: z
    .array(
      z
        .object({
          id: z.coerce.number<number>().min(1).max(9999999).optional(),
          storage: z
            .string()
            .refine((type) => SUPPORTED_RESOURCE_LINK.includes(type), {
              message: '非法的资源链接类型'
            }),
          hash: z.string().max(107),
          content: z
            .string()
            .max(1007, { message: '您的资源链接内容最多 1007 个字符' }),
          size: z.string().regex(ResourceSizeRegex, {
            message: '请选择资源的大小, MB 或 GB'
          }),
          code: z
            .string()
            .trim()
            .max(1007, { message: '资源提取码长度最多 1007 位' }),
          password: z
            .string()
            .max(1007, { message: '资源解压码长度最多 1007 位' })
        })
        .superRefine((link, ctx) => {
          if (link.storage === 's3') {
            // 新建场景: 必须携带上传 token (走 link.hash 字段透传)
            // 更新场景: 若已存在同 id 的 s3 link, 可不携带 token 表示未变更
            if (!link.hash.trim() && typeof link.id !== 'number') {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: '请先上传资源文件',
                path: ['hash']
              })
            }
            return
          }

          if (!link.content.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: '请输入资源链接',
              path: ['content']
            })
          }
        })
    )
    .min(1, { message: '请至少添加一个资源链接' })
    .max(10, { message: '单个资源最多添加 10 条链接' }),
  type: z
    .array(z.string())
    .min(1, { message: '请选择至少一个资源类型' })
    .max(10, { message: '您的单个资源最多有 10 条链接' })
    .refine((types) => types.every((type) => SUPPORTED_TYPE.includes(type)), {
      message: '非法的类型'
    }),
  language: z
    .array(z.string())
    .min(1, { message: '请选择至少一个资源语言' })
    .max(10, { message: '您的单个资源最多有 10 个语言' })
    .refine(
      (types) => types.every((type) => SUPPORTED_LANGUAGE.includes(type)),
      { message: '非法的语言' }
    ),
  platform: z
    .array(z.string())
    .min(1, { message: '请选择至少一个资源平台' })
    .max(10, { message: '您的单个资源最多有 10 个平台' })
    .refine(
      (types) => types.every((type) => SUPPORTED_PLATFORM.includes(type)),
      { message: '非法的平台' }
    ),
  emulatorType: z
    .array(z.string())
    .max(10, { message: '您的单个资源最多有 10 个模拟器类型' })
    .refine(
      (types) => types.every((type) => SUPPORTED_EMULATOR_TYPE.includes(type)),
      { message: '非法的模拟器类型' }
    ),
  modelName: z
    .string({ message: '模型型号格式不正确' })
    .trim()
    .max(107, { message: '模型型号最多 107 个字符' })
})

export const patchResourceCreateSchema = patchResourceBaseSchema.superRefine(
  refineResourceSectionType
)

export const patchResourceUpdateSchema = patchResourceBaseSchema
  .merge(
    z.object({
      resourceId: z.coerce.number().min(1).max(9999999)
    })
  )
  .superRefine(refineResourceSectionType)

export const updatePatchBannerSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999),
  image: nonEmptyFileSchema,
  imageOriginal: nonEmptyFileSchema.optional()
})

export const getMoyuPatchResourceSchema = z.object({
  vndbId: z
    .string()
    .max(10, { message: 'VNDB ID 最多 10 个字符' })
    .regex(/^v\d+$/, { message: 'VNDB ID 格式不正确, 例如 v19658' })
})

export const updatePatchResourceStatsSchema = z.object({
  patchId: z.coerce.number({ message: 'ID 必须为数字' }).min(1).max(9999999),
  resourceId: z.coerce.number({ message: 'ID 必须为数字' }).min(1).max(9999999),
  linkId: z.coerce.number({ message: 'ID 必须为数字' }).min(1).max(9999999)
})

export const createPatchFeedbackSchema = z.object({
  patchId: z.coerce.number({ message: 'ID 必须为数字' }).min(1).max(9999999),
  content: z
    .string({ message: '反馈内容为必填字段' })
    .min(10, { message: '反馈信息最少 10 个字符' })
    .max(5000, { message: '反馈信息最多 5000 个字符' })
})

export const createPatchCommentReportSchema = z.object({
  commentId: z.coerce
    .number({ message: '评论 ID 必须为数字' })
    .min(1)
    .max(9999999),
  patchId: z.coerce
    .number({ message: '游戏 ID 必须为数字' })
    .min(1)
    .max(9999999),
  content: z
    .string({ message: '举报原因为必填字段' })
    .min(2, { message: '举报原因最少 2 个字符' })
    .max(5000, { message: '举报原因最多 5000 个字符' })
})

export const createPatchRatingReportSchema = z.object({
  ratingId: z.coerce
    .number({ message: '评价 ID 必须为数字' })
    .min(1)
    .max(9999999),
  patchId: z.coerce
    .number({ message: '游戏 ID 必须为数字' })
    .min(1)
    .max(9999999),
  content: z
    .string({ message: '举报原因为必填字段' })
    .min(2, { message: '举报原因最少 2 个字符' })
    .max(5000, { message: '举报原因最多 5000 个字符' })
})

export const togglePatchFavoriteSchema = z.object({
  patchId: z.coerce
    .number({ message: '游戏 ID 必须为数字' })
    .min(1)
    .max(9999999),
  folderId: z.coerce
    .number({ message: '收藏文件夹 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

export const patchRatingCreateSchema = z.object({
  patchId: z.coerce
    .number({ message: 'patch rating ID 格式不正确' })
    .min(1)
    .max(9999999),
  recommend: z
    .string({ message: '推荐程度不正确' })
    .refine((v) => KUN_GALGAME_RATING_RECOMMEND_CONST.includes(v as any), {
      message: '推荐程度不正确'
    }),
  overall: z.coerce
    .number({ message: '评分不正确' })
    .min(1, { message: '评分最小为 1' })
    .max(10, { message: '评分最大为 10' }),
  playStatus: z
    .string({ message: '游玩状态不正确' })
    .refine((v) => KUN_GALGAME_RATING_PLAY_STATUS_CONST.includes(v as any), {
      message: '游玩状态不正确'
    }),
  shortSummary: z
    .string({ message: '简评不正确' })
    .trim()
    .max(1314, { message: '简评最多 1314 字' }),
  spoilerLevel: z
    .string({ message: '剧透等级不正确' })
    .refine((v) => KUN_GALGAME_RATING_SPOILER_CONST.includes(v as any), {
      message: '剧透等级不正确'
    })
})

export const patchRatingUpdateSchema = z.object({
  ratingId: z.coerce
    .number({ message: 'patch rating ID 格式不正确' })
    .min(1)
    .max(9999999),
  recommend: z
    .string({ message: '推荐程度不正确' })
    .refine((v) => KUN_GALGAME_RATING_RECOMMEND_CONST.includes(v as any), {
      message: '推荐程度不正确'
    }),
  overall: z.coerce
    .number({ message: '评分不正确' })
    .min(1, { message: '评分最小为 1' })
    .max(10, { message: '评分最大为 10' }),
  playStatus: z
    .string({ message: '游玩状态不正确' })
    .refine((v) => KUN_GALGAME_RATING_PLAY_STATUS_CONST.includes(v as any), {
      message: '游玩状态不正确'
    }),
  shortSummary: z
    .string({ message: '简评不正确' })
    .trim()
    .max(1314, { message: '简评最多 1314 字' }),
  spoilerLevel: z
    .string({ message: '剧透等级不正确' })
    .refine((v) => KUN_GALGAME_RATING_SPOILER_CONST.includes(v as any), {
      message: '剧透等级不正确'
    })
})
