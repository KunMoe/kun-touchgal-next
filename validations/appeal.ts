import * as z from 'zod'

export const getUserAppealSchema = z.object({
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(30)
})

const appealTaskIdSchema = z.coerce
  .number({ message: '审核任务 ID 必须为数字' })
  .min(1)
  .max(9999999)

export const submitAppealSchema = z.discriminatedUnion('contentType', [
  z.object({
    contentType: z.literal('comment'),
    taskId: appealTaskIdSchema,
    content: z
      .string()
      .trim()
      .min(1, { message: '评论的内容最少为 1 个字符' })
      .max(10007, { message: '评论的内容最多为 10007 个字符' })
  }),
  z.object({
    contentType: z.literal('rating'),
    taskId: appealTaskIdSchema,
    shortSummary: z
      .string()
      .trim()
      .min(1, { message: '评价内容不可为空' })
      .max(1314, { message: '评价内容不能超过 1314 个字符' })
  }),
  z.object({
    contentType: z.literal('resource'),
    taskId: appealTaskIdSchema,
    name: z.string().trim().max(300, { message: '资源名称最多 300 个字符' }),
    note: z.string().trim().max(10007, { message: '资源备注最多 10007 字' })
  })
])
