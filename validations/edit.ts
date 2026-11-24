import * as z from 'zod'
import { nonEmptyFileSchema } from './file'
import { MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES } from '~/config/cache'
import { INT4_MAX } from '~/constants/db-limits'

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
  dlsiteTags: optionalStringArray,
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
  dlsiteTags: z.array(z.string()).optional().default([]),
  introduction: z
    .string()
    .trim()
    .min(10, { message: '游戏介绍是必填项, 最少 10 个字符' })
    .max(100007, { message: '游戏介绍最多 100007 字' })
    .refine(isIntroductionWithinByteLimit, {
      message: '游戏介绍内容体积过大，请精简后再提交'
    }),
  // 手动标签按差量提交: 要移除的现存标签给 id, 要新增的给名字, 都为空即不动。请求不再
  // 回传现存标签的全集, 所以新增的条数可以与 POST 的手动标签同为 100; 移除至多是全部
  // 现存标签 (外部来源能把单个 Galgame 推到 165 个), 1000 只是单请求的成本上界
  removeTagIds: z
    .array(
      z
        .number({ message: '标签 ID 必须为数字' })
        .int({ message: '标签 ID 必须为整数' })
        .positive({ message: '标签 ID 必须为正数' })
        // patch_tag.id 是 int4, 越界的值进了查询会抛 P2020
        .max(INT4_MAX, { message: '标签 ID 超出可用范围' }),
      // 发布前打开的编辑页按旧协议提交时没有这两个字段
      { message: '标签改动的格式不正确, 请刷新页面后重试' }
    )
    .max(1000, { message: '一次最多移除 1000 个标签' }),
  addTagNames: z
    .array(
      z
        .string()
        .trim()
        .min(1, { message: '单个标签至少一个字符' })
        // patch_tag.name 是 VarChar(107), 放行更长会在事务提交后的 batchTag 才抛 22001
        .max(107, { message: '单个标签至多 107 个字符' }),
      { message: '标签改动的格式不正确, 请刷新页面后重试' }
    )
    .max(100, { message: '一次最多新增 100 个标签' }),
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
    .optional(),
  // 打开编辑页时读到的字段指纹 (sha256), 原样带回; 服务端据此发现期间别人的修改
  baseFingerprint: z
    .string({ message: '编辑基线无效, 请刷新页面后重试' })
    .regex(/^[0-9a-f]{64}$/, { message: '编辑基线无效, 请刷新页面后重试' })
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
