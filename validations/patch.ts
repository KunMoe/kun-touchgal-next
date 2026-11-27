import * as z from 'zod'
import { kunId, kunInt, kunLimit, kunPage } from './primitives'
import { ResourceSizeRegex } from '~/utils/validate'
import { nonEmptyFileSchema } from './file'
import { findTaxonomyViolations } from './resourceTaxonomy'
import type { ResourceTaxonomyRow } from './resourceTaxonomy'
import {
  SUPPORTED_TYPE,
  SUPPORTED_LANGUAGE,
  SUPPORTED_PLATFORM,
  SUPPORTED_EMULATOR_TYPE,
  SUPPORTED_RESOURCE_SECTION
} from '~/constants/resource'
import { KUN_LINK_STORAGES } from '~/constants/permission'
import {
  KUN_GALGAME_RATING_RECOMMEND_CONST,
  KUN_GALGAME_RATING_SPOILER_CONST,
  KUN_GALGAME_RATING_PLAY_STATUS_CONST
} from '~/constants/galgame'

export const patchTagChangeSchema = z.object({
  patchId: kunId('游戏 ID'),
  tagId: z
    .array(kunId('标签 ID'))
    .min(1)
    .max(107, { message: '一个 Galgame 最多有 107 个标签' })
})

export const patchCompanyChangeSchema = z.object({
  patchId: kunId('游戏 ID'),
  companyId: z
    .array(kunId('会社 ID'))
    .min(1)
    .max(107, { message: '一个 Galgame 最多有 107 个会社' })
})

export const patchCommentCreateSchema = z.object({
  patchId: kunId('游戏 ID'),
  parentId: kunId('评论 ID').nullable(),
  resourceId: kunId('资源 ID').optional(),
  content: z
    .string()
    .trim()
    .min(1, { message: '评论的内容最少为 1 个字符' })
    .max(10007, { message: '评论的内容最多为 10007 个字符' }),
  isSpoiler: z.boolean().optional().default(false)
})

export const patchCommentUpdateSchema = z.object({
  commentId: kunId('评论 ID'),
  content: z
    .string()
    .trim()
    .min(1, { message: '评论的内容最少为 1 个字符' })
    .max(10007, { message: '评论的内容最多为 10007 个字符' }),
  isSpoiler: z.boolean().optional().default(false)
})

export const getPatchCommentSchema = z.object({
  patchId: kunId('游戏 ID'),
  resourceId: kunId('资源 ID').optional(),
  page: kunPage(),
  limit: kunLimit(50),
  commentId: kunId('评论 ID').optional()
})

// section 与 type 的联动约束: 所选类型必须属于对应资源类别下允许的类型;
// 另有 platform/type 触发的条件必填: 模拟器平台须选模拟器类型, AI 补丁须填模型型号。
// 规则本身在 findTaxonomyViolations, 这里只把其中三类转成报错
const refineResourceSectionType = (
  data: ResourceTaxonomyRow,
  ctx: z.RefinementCtx
) => {
  for (const violation of findTaxonomyViolations(data)) {
    switch (violation.kind) {
      case 'section-type':
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '所选资源类型不属于当前资源类别',
          path: ['type']
        })
        break
      case 'emulator-type-required':
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '选择模拟器平台时请选择模拟器类型',
          path: ['emulatorType']
        })
        break
      case 'model-name-required':
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '发布 AI 翻译补丁时请填写模型型号',
          path: ['modelName']
        })
        break
      // 词表成员与非空由各字段自己的校验报, 文案各不相同。孤儿值不报: 表单把字段藏起来
      // 之后会留下残值, 由 create / update 在落库前归一化
      case 'unknown-value':
      case 'empty':
      case 'emulator-type-orphan':
      case 'model-name-orphan':
        break
      default:
        violation satisfies never
    }
  }
}

// 一条资源链接里由用户填写的字段。发布 / 编辑的两种链接形态、申诉 (validations/appeal.ts)
// 与送审的限长 (server/moderation/subject.ts) 读的都是这一份
export const resourceLinkFields = {
  content: z
    .string()
    .max(1007, { message: '您的资源链接内容最多 1007 个字符' }),
  size: z.string().regex(ResourceSizeRegex, {
    message: '请选择资源的大小, MB 或 GB'
  }),
  code: z.string().trim().max(1007, { message: '资源提取码长度最多 1007 位' }),
  password: z.string().max(1007, { message: '资源解压码长度最多 1007 位' })
}

const linkId = kunId('链接 ID').optional()

export const RESOURCE_UPLOAD_REQUIRED = '请先上传资源文件'

// 对象存储的链接: 地址、对象 key 与大小都归服务端, 在绑定上传文件时写下 (见
// bindUploadedResource), 请求里只说两件事 —— 换成哪一次上传 (uploadToken), 或者沿用库里的
// 哪一行 (id, 不带 uploadToken)。库里的 hash 列是历史对象的校验码, 只读, 不从请求写入
const s3LinkSchema = z
  .object({
    storage: z.literal('s3'),
    id: linkId,
    uploadToken: z
      .string()
      .trim()
      .max(107, { message: '上传凭证不正确, 请重新上传文件' })
      .optional(),
    // 过渡守卫 (一个发布周期后删除): 发布前打开的旧页面仍把上传 token 或库里的校验码放在
    // hash 里回传。不拦的话 hash 会被当作多余的键丢掉, 换文件的请求就成了「沿用原文件」,
    // 页面却提示更新成功
    hash: z
      .string()
      .max(0, { message: '页面版本已更新, 请刷新后重试' })
      .optional(),
    code: resourceLinkFields.code,
    password: resourceLinkFields.password
  })
  // 旧页面把 token 放在 hash 里: 上面的守卫已经让它刷新, 这里不再多报一条「请先上传」
  .refine(
    (link) => link.id !== undefined || !!link.uploadToken || !!link.hash,
    {
      message: RESOURCE_UPLOAD_REQUIRED,
      path: ['uploadToken']
    }
  )

const EXTERNAL_LINK_STORAGES = KUN_LINK_STORAGES.filter(
  (storage) => storage !== 's3'
)

// 外链: 地址与大小由用户填。对象存储的字段 (uploadToken、hash) 不在这个形态里, 带了也不取
const externalLinkSchema = z.object({
  storage: z.enum(EXTERNAL_LINK_STORAGES),
  id: linkId,
  content: resourceLinkFields.content.refine((value) => value.trim() !== '', {
    message: '请输入资源链接'
  }),
  size: resourceLinkFields.size,
  code: resourceLinkFields.code,
  password: resourceLinkFields.password
})

// 链接按存储类型分成两种形态, 各自只收属于自己的字段: 同一个字段不再随存储类型换含义
export const resourceLinkSchema = z.discriminatedUnion(
  'storage',
  [s3LinkSchema, externalLinkSchema],
  { error: '非法的资源链接类型' }
)

export type ResourceLinkInput = z.infer<typeof resourceLinkSchema>

const patchResourceBaseSchema = z.object({
  // <number> 仅标注 input 类型, 使表单 (zodResolver) 与 API 复用同一 schema 时类型对齐
  patchId: kunId('游戏 ID'),
  section: z
    .string()
    .refine((type) => SUPPORTED_RESOURCE_SECTION.includes(type), {
      message: '资源链接类型仅能为 Galgame 或补丁'
    }),
  name: z.string().max(300, { message: '资源名称最多 300 个字符' }),
  note: z.string().max(10007, { message: '资源备注最多 10007 字' }),
  links: z
    .array(resourceLinkSchema)
    .min(1, { message: '请至少添加一个资源链接' })
    .max(10, { message: '单个资源最多添加 10 条链接' })
    // 一条已有的链接 (带 id) 只能提交一次: 重复提交会让几行共用同一个存储对象, 之后删掉
    // 其中一行就把对象一并带走
    .refine(
      (links) => {
        const ids = links.flatMap((link) =>
          link.id === undefined ? [] : [link.id]
        )
        return new Set(ids).size === ids.length
      },
      { message: '同一条资源链接不能重复提交, 请刷新后重试' }
    ),
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
      resourceId: kunId('资源 ID')
    })
  )
  .superRefine(refineResourceSectionType)

export const updatePatchBannerSchema = z.object({
  patchId: kunId('游戏 ID'),
  image: nonEmptyFileSchema,
  imageOriginal: nonEmptyFileSchema.optional(),
  // 撤下违规图片: 旧版本不留宽限期、立即删除
  discardOld: z.enum(['true', 'false']).optional()
})

export const getMoyuPatchResourceSchema = z.object({
  vndbId: z
    .string()
    .max(10, { message: 'VNDB ID 最多 10 个字符' })
    .regex(/^v\d+$/, { message: 'VNDB ID 格式不正确, 例如 v19658' })
})

export const updatePatchResourceStatsSchema = z.object({
  patchId: kunId('游戏 ID'),
  resourceId: kunId('资源 ID'),
  linkId: kunId('链接 ID')
})

export const createPatchFeedbackSchema = z.object({
  patchId: kunId('游戏 ID'),
  content: z
    .string({ message: '反馈内容为必填字段' })
    .min(10, { message: '反馈信息最少 10 个字符' })
    .max(5000, { message: '反馈信息最多 5000 个字符' })
})

export const createPatchCommentReportSchema = z.object({
  commentId: kunId('评论 ID'),
  patchId: kunId('游戏 ID'),
  content: z
    .string({ message: '举报原因为必填字段' })
    .min(2, { message: '举报原因最少 2 个字符' })
    .max(5000, { message: '举报原因最多 5000 个字符' })
})

export const createPatchRatingReportSchema = z.object({
  ratingId: kunId('评价 ID'),
  patchId: kunId('游戏 ID'),
  content: z
    .string({ message: '举报原因为必填字段' })
    .min(2, { message: '举报原因最少 2 个字符' })
    .max(5000, { message: '举报原因最多 5000 个字符' })
})

export const togglePatchFavoriteSchema = z.object({
  patchId: kunId('游戏 ID'),
  folderId: kunId('收藏文件夹 ID')
})

export const patchRatingCreateSchema = z.object({
  patchId: kunId('游戏 ID'),
  recommend: z
    .string({ message: '推荐程度不正确' })
    .refine((v) => KUN_GALGAME_RATING_RECOMMEND_CONST.includes(v as any), {
      message: '推荐程度不正确'
    }),
  overall: kunInt(1, 10, '评分须为 1～10 的整数'),
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
  ratingId: kunId('评价 ID'),
  recommend: z
    .string({ message: '推荐程度不正确' })
    .refine((v) => KUN_GALGAME_RATING_RECOMMEND_CONST.includes(v as any), {
      message: '推荐程度不正确'
    }),
  overall: kunInt(1, 10, '评分须为 1～10 的整数'),
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
