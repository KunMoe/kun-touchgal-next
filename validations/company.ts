import * as z from 'zod'
import { galgameSchema } from './galgame'
import { DEFAULT_TAG_COMPANY_MIN_RATING_COUNT } from '~/utils/galgameFilter'

export const createCompanySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: '会社名不可为空' })
    .max(107, { message: '单个会社名最大 107 个字符' }),
  introduction: z
    .string()
    .trim()
    .max(10007, { message: '会社的介绍最大 10007 个字符' })
    .optional(),
  alias: z.array(
    z
      .string()
      .trim()
      .min(1, { message: '会社别名不可为空' })
      .max(17, { message: '单个会社的别名最大 17 个字符' })
  ),
  primary_language: z
    .array(
      z
        .string()
        .trim()
        .min(1, { message: '主要语言不可为空' })
        .max(17, { message: '单个主要语言最大 17 个字符' })
    )
    .min(1, { message: '至少需要一个主要语言' }),
  official_website: z.array(
    z
      .string()
      .trim()
      .min(1, { message: '会社别名不可为空' })
      .max(10007, { message: '单个官方网站最大 10007 个字符' })
  ),
  parent_brand: z.array(
    z
      .string()
      .trim()
      .min(1, { message: '会社别名不可为空' })
      .max(17, { message: '单个母公司最大 17 个字符' })
  )
})

export const updateCompanySchema = createCompanySchema.merge(
  z.object({
    companyId: z.coerce.number().min(1).max(9999999)
  })
)

export const getCompanySchema = z.object({
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(100)
})

export const getCompanyByIdSchema = z.object({
  companyId: z.coerce.number().min(1).max(9999999)
})

const galgameListQuerySchema = galgameSchema
  .pick({
    selectedType: true,
    selectedLanguage: true,
    selectedPlatform: true,
    sortField: true,
    sortOrder: true,
    page: true,
    limit: true,
    yearString: true,
    monthString: true,
    minRatingCount: true
  })
  .extend({
    minRatingCount: z.coerce
      .number()
      .int()
      .min(0)
      .max(999999)
      .default(DEFAULT_TAG_COMPANY_MIN_RATING_COUNT)
  })

export const getPatchByCompanySchema = z
  .object({
    companyId: z.coerce.number().min(1).max(9999999)
  })
  .merge(galgameListQuerySchema)

export const searchCompanySchema = z.object({
  query: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(107, { message: '单个搜索关键词最大长度为 107' })
    )
    .min(1)
    .max(10, { message: '您最多使用 10 组关键词' })
})
