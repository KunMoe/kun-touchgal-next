import * as z from 'zod'
import { kunId, kunLimit, kunPage } from './primitives'
import { patchResourceCreateSchema } from './patch'

export const getUserAppealSchema = z.object({
  page: kunPage(),
  limit: kunLimit(30),
  // 各取值见 UserAppealState; 申诉页默认只列出还能申诉的内容
  state: z
    .enum([
      'all',
      'appealable',
      'pending',
      'approved',
      'rejected',
      'unavailable'
    ])
    .default('appealable')
})

const appealTaskIdSchema = kunId('审核任务 ID')

const resourceShape = patchResourceCreateSchema.shape
const resourceLinkShape = resourceShape.links.element.shape

// 资源申诉可改的链接字段就是送审的那几个, 各字段的约束直接取发布 / 编辑资源用的同一份
// schema。链接按 id 对应资源已有的链接行: 申诉不增删链接, 不换存储类型, 也不重新上传文件。
// 每条链接只提交作者可改的字段 (取决于存储类型, 见 getAppealEditableLinkFields), 所以
// 四个字段在这里都是可选的: 哪些必须带、链接地址是否必填, 由服务端对着库中的行判断。
// 不可改的字段不提交也就不校验 —— 库里不合现行格式的旧值不会卡住申诉
const appealResourceLinkSchema = z.object({
  id: kunId('链接 ID'),
  content: resourceLinkShape.content.optional(),
  size: resourceLinkShape.size.optional(),
  code: resourceLinkShape.code.optional(),
  password: resourceLinkShape.password.optional()
})

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
    note: z.string().trim().max(10007, { message: '资源备注最多 10007 字' }),
    // 只有 AI 翻译补丁有模型型号: 是否适用、是否必填由服务端对着库中的资源判断
    modelName: resourceShape.modelName.optional(),
    // 发布前就打开着的旧申诉页不带 links: 提示刷新, 而不是抛出默认的类型错误
    links: z
      .array(appealResourceLinkSchema, {
        message: '申诉页面已更新, 请刷新后重试'
      })
      .max(10, { message: '单个资源最多 10 条链接' })
  })
])
