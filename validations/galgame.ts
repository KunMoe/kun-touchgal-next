import * as z from 'zod'
import {
  ALL_SUPPORTED_LANGUAGE,
  ALL_SUPPORTED_PLATFORM,
  ALL_SUPPORTED_TYPE
} from '~/constants/resource'
import {
  DEFAULT_GALGAME_FILTER_VALUE,
  DEFAULT_GALGAME_MIN_RATING_COUNT,
  DEFAULT_GALGAME_MONTH_STRING,
  DEFAULT_GALGAME_YEAR_STRING,
  MAX_GALGAME_FILTER_VALUES,
  exceedsGalgameFilterLimit
} from '~/utils/galgameFilter'

const getSupportedValueSchema = (values: string[], message: string) =>
  z
    .string()
    .min(1)
    .max(107)
    .refine((value) => values.includes(value), { message })

const getBoundedFilterStringSchema = (message: string) =>
  z
    .string()
    .max(1007)
    .refine((value) => !exceedsGalgameFilterLimit(value), { message })

export const galgameSchema = z.object({
  selectedType: getSupportedValueSchema(
    ALL_SUPPORTED_TYPE,
    '请选择我们支持的 Galgame 类型'
  ).default(DEFAULT_GALGAME_FILTER_VALUE),
  selectedLanguage: getSupportedValueSchema(
    ALL_SUPPORTED_LANGUAGE,
    '请选择我们支持的 Galgame 语言'
  ).default(DEFAULT_GALGAME_FILTER_VALUE),
  selectedPlatform: getSupportedValueSchema(
    ALL_SUPPORTED_PLATFORM,
    '请选择我们支持的 Galgame 平台'
  ).default(DEFAULT_GALGAME_FILTER_VALUE),
  sortField: z.union([
    z.literal('resource_update_time'),
    z.literal('created'),
    z.literal('view'),
    z.literal('download'),
    z.literal('favorite'),
    z.literal('rating')
  ]),
  sortOrder: z.union([z.literal('asc'), z.literal('desc')]),
  page: z.coerce.number().int().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(24),
  yearString: getBoundedFilterStringSchema(
    `您最多选择 ${MAX_GALGAME_FILTER_VALUES} 组年份`
  ).default(DEFAULT_GALGAME_YEAR_STRING),
  monthString: getBoundedFilterStringSchema(
    `您最多选择 ${MAX_GALGAME_FILTER_VALUES} 组月份`
  ).default(DEFAULT_GALGAME_MONTH_STRING),
  minRatingCount: z.coerce
    .number()
    .int()
    .min(0)
    .max(999999)
    .default(DEFAULT_GALGAME_MIN_RATING_COUNT)
})
