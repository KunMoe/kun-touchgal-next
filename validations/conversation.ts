import * as z from 'zod'

const conversationIdSchema = z.coerce.number().int().min(1).max(9999999)

// 会话 ID 从 URL 路径段 (string) 与页面 (number) 两个方向进来, 统一在此收口:
// 越过 int4 会让 prisma 抛 P2020, 超过安全整数还会退化成浮点抛
// PrismaClientValidationError, 都必须在触达 prisma 之前截住
export const parseConversationId = (id: string | number): number | string => {
  const result = conversationIdSchema.safeParse(id)
  return result.success ? result.data : '无效的会话 ID'
}

export const createConversationSchema = z.object({
  targetUserId: z.coerce.number().min(1).max(9999999)
})

export const getConversationsSchema = z.object({
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(30)
})

export const getConversationMessagesSchema = z.object({
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(50)
})

export const sendPrivateMessageSchema = z.object({
  content: z
    .string()
    .min(1, { message: '消息内容不能为空' })
    .max(2000, { message: '消息内容最多 2000 个字符' })
})

export const updatePrivateMessageSchema = z.object({
  messageId: z.coerce.number().min(1).max(9999999),
  content: z
    .string()
    .min(1, { message: '消息内容不能为空' })
    .max(2000, { message: '消息内容最多 2000 个字符' })
})

export const deletePrivateMessageSchema = z.object({
  messageId: z.coerce.number().min(1).max(9999999)
})
