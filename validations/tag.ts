import * as z from 'zod'
import { galgameSchema } from './galgame'
import { DEFAULT_TAG_COMPANY_MIN_RATING_COUNT } from '~/utils/galgameFilter'

export const createTagSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: '标签名不可为空' })
    .max(17, { message: '单个标签最大 17 个字符' }),
  introduction: z
    .string()
    .trim()
    .max(10007, { message: '标签的介绍最大 10007 个字符' })
    .optional(),
  alias: z.array(
    z
      .string()
      .trim()
      .min(1, { message: '标签名不可为空' })
      .max(17, { message: '单个标签的别名最大 17 个字符' })
  )
})

export const updateTagSchema = createTagSchema.merge(
  z.object({
    // <number> 仅标注 input 类型, 使表单 (zodResolver) 与 API 复用同一 schema 时类型对齐
    tagId: z.coerce.number<number>().min(1).max(9999999)
  })
)

export const getTagSchema = z.object({
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(100)
})

export const getTagByIdSchema = z.object({
  tagId: z.coerce.number().min(1).max(9999999)
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

export const getPatchByTagSchema = z
  .object({
    tagId: z.coerce.number().min(1).max(9999999)
  })
  .merge(galgameListQuerySchema)
