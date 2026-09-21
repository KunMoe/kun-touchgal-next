import { z } from 'zod'
import { nonEmptyFileSchema } from './file'
import { MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES } from '~/config/cache'

const introductionTextEncoder = new TextEncoder()

const isIntroductionWithinByteLimit = (value: string) =>
  introductionTextEncoder.encode(value).length <=
  MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES

const duplicateQueryField = (maxLength: number) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') {
      return undefined
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }, z.string().max(maxLength).optional())

const optionalVndbId = z
  .string()
  .max(10, { message: 'VNDB ID 最多 10 个字符' })
  .regex(/^(v\d+)?$/i, { message: 'VNDB ID 格式不正确, 例如 v19658' })

const optionalVndbRelationId = z
  .string()
  .max(10, { message: 'VNDB Relation ID 最多 10 个字符' })
  .regex(/^(r\d+)?$/i, { message: 'VNDB Relation ID 格式不正确, 例如 r5879' })

// patch.bangumi_id / steam_id 是 Int 列 (int4). 仅靠 max(10) 会放行 2147483648 ~
// 9999999999, 这些值一旦进入 Prisma 查询或写入就抛 P2020 而非返回业务错误消息,
// 冒泡到路由即 500. 真实 Bangumi ID / Steam AppID 都远小于此, 在 schema 层挡掉
export const INT4_MAX = 2147483647
export const INT4_MIN = -2147483648

const isWithinInt4 = (value: string) => !value || Number(value) <= INT4_MAX

const optionalBangumiId = z
  .string()
  .max(10, { message: 'Bangumi ID 最多 10 个字符' })
  .regex(/^(\d+)?$/, { message: 'Bangumi ID 必须为纯数字' })
  .refine(isWithinInt4, { message: 'Bangumi ID 超出可用范围' })

const optionalSteamId = z
  .string()
  .max(10, { message: 'Steam ID 最多 10 个字符' })
  .regex(/^(\d+)?$/, { message: 'Steam ID 必须为纯数字' })
  .refine(isWithinInt4, { message: 'Steam ID 超出可用范围' })

const optionalDlsiteCode = z
  .string()
  .max(20, { message: 'DLsite Code 最多 20 个字符' })
  .regex(/^((RJ|VJ)\d+)?$/i, {
    message: 'DLsite Code 格式不正确, 例如 RJ01405813'
  })

const optionalCircleField = z.string().max(500).optional().default('')

const optionalStringArray = z
  .string()
  .optional()
  .default('[]')
  .transform((val) => {
    try {
      const parsed = JSON.parse(val)
      return Array.isArray(parsed)
        ? parsed.filter((s: unknown) => typeof s === 'string')
        : []
    } catch {
      return []
    }
  })

export const patchCreateSchema = z.object({
  banner: nonEmptyFileSchema,
  bannerOriginal: nonEmptyFileSchema.optional(),
  name: z
    .string()
    .trim()
    .min(1, { message: '游戏名称是必填项' })
    // patch.name 是 VarChar(1007), 放行更长会在 patch.create/update 抛 22001 变 500
    .max(1007, { message: '游戏名称最多 1007 个字符' }),
  vndbId: optionalVndbId,
  vndbRelationId: optionalVndbRelationId,
  bangumiId: optionalBangumiId,
  steamId: optionalSteamId,
  dlsiteCode: optionalDlsiteCode,
  dlsiteCircleName: optionalCircleField,
  dlsiteCircleLink: optionalCircleField,
  vndbTags: optionalStringArray,
  vndbDevelopers: optionalStringArray,
  bangumiTags: optionalStringArray,
  bangumiDevelopers: optionalStringArray,
  steamTags: optionalStringArray,
  steamDevelopers: optionalStringArray,
  steamAliases: optionalStringArray,
  introduction: z
    .string()
    .trim()
    .min(10, { message: '游戏介绍是必填项, 最少 10 个字符' })
    .max(100007, { message: '游戏介绍最多 100007 字' })
    .refine(isIntroductionWithinByteLimit, {
      message: '游戏介绍内容体积过大，请精简后再提交'
    }),
  alias: z
    .string()
    .max(2333, { message: '别名字符串总长度不可超过 2333 个字符' }),
  tag: z
    .string()
    .max(2333, { message: '标签字符串总长度不可超过 2333 个字符' }),
  // patch.released 是 VarChar(107)
  released: z.string().max(107, { message: '发售日期最多 107 个字符' }),
  contentLimit: z.string().max(10)
})

export const patchUpdateSchema = z.object({
  id: z.coerce.number().min(1).max(9999999),
  name: z
    .string()
    .trim()
    .min(1, { message: '游戏名称是必填项' })
    // patch.name 是 VarChar(1007), 放行更长会在 patch.create/update 抛 22001 变 500
    .max(1007, { message: '游戏名称最多 1007 个字符' }),
  vndbId: optionalVndbId,
  vndbRelationId: optionalVndbRelationId,
  bangumiId: optionalBangumiId,
  steamId: optionalSteamId,
  dlsiteCode: optionalDlsiteCode,
  dlsiteCircleName: optionalCircleField,
  dlsiteCircleLink: optionalCircleField,
  vndbTags: z.array(z.string()).optional().default([]),
  vndbDevelopers: z.array(z.string()).optional().default([]),
  bangumiTags: z.array(z.string()).optional().default([]),
  bangumiDevelopers: z.array(z.string()).optional().default([]),
  steamTags: z.array(z.string()).optional().default([]),
  steamDevelopers: z.array(z.string()).optional().default([]),
  steamAliases: z.array(z.string()).optional().default([]),
  introduction: z
    .string()
    .trim()
    .min(10, { message: '游戏介绍是必填项, 最少 10 个字符' })
    .max(100007, { message: '游戏介绍最多 100007 字' })
    .refine(isIntroductionWithinByteLimit, {
      message: '游戏介绍内容体积过大，请精简后再提交'
    }),
  // 条数上限是 batchTag 单请求成本上界(嵌套 OR 查询约 0.3ms/元素, 超 3 万元素撞 PG
  // 绑定参数上限在主事务提交后才 500), 不是产品上限: PUT 的 tag 承载 patch 全部现存
  // 标签(rewrite store 整份灌入 patch.tags, batchTag 全量同步), 外部来源即可把单个
  // patch 推到 165 个, 不能与 POST 手动标签的 100 对齐
  tag: z
    .array(
      z
        .string()
        .trim()
        .min(1, { message: '单个标签至少一个字符' })
        // patch_tag.name 是 VarChar(107), 放行更长会在事务提交后的 batchTag 才抛 22001
        .max(107, { message: '单个标签至多 107 个字符' })
    )
    .max(1000, { message: '一个 Galgame 最多提交 1000 个标签' }),
  alias: z
    .array(
      z
        .string()
        .trim()
        .min(1, { message: '单个别名至少一个字符' })
        .max(500, { message: '单个别名至多 500 个字符' })
    )
    .max(100, { message: '您最多使用 100 个别名' }),
  contentLimit: z.string().max(10),
  released: z
    .string()
    .max(107, { message: '发售日期最多 107 个字符' })
    .optional()
})

export const duplicateSchema = z
  .object({
    vndbId: duplicateQueryField(10),
    vndbRelationId: duplicateQueryField(10),
    bangumiId: duplicateQueryField(10),
    steamId: duplicateQueryField(10),
    dlsiteCode: duplicateQueryField(20),
    title: duplicateQueryField(1007),
    excludeId: duplicateQueryField(10)
  })
  .refine(
    (data) =>
      [
        data.vndbId,
        data.vndbRelationId,
        data.bangumiId,
        data.steamId,
        data.dlsiteCode,
        data.title
      ].some((value) => typeof value === 'string'),
    {
      message: '请至少提供一个查重字段'
    }
  )

export const imageSchema = z.object({
  image: nonEmptyFileSchema
})
