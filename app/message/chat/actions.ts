'use server'

import { z } from 'zod'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import {
  parseConversationId,
  getConversationsSchema,
  getConversationMessagesSchema
} from '~/validations/conversation'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { getConversations } from '~/app/api/message/conversation/service'
import { getConversationMessages } from '~/app/api/message/conversation/[id]/service'

export const kunGetConversationsAction = async (
  params: z.infer<typeof getConversationsSchema>
) => {
  const input = safeParseSchema(getConversationsSchema, params)
  if (typeof input === 'string') {
    return input
  }
  const payload = await verifyHeaderCookie()
  if (!payload) {
    return '用户登录失效'
  }

  const response = await getConversations(input, payload.uid)
  return response
}

export const kunGetConversationMessagesAction = async (
  conversationId: number,
  params: z.infer<typeof getConversationMessagesSchema>
) => {
  const parsedId = parseConversationId(conversationId)
  if (typeof parsedId === 'string') {
    return parsedId
  }

  const input = safeParseSchema(getConversationMessagesSchema, params)
  if (typeof input === 'string') {
    return input
  }
  const payload = await verifyHeaderCookie()
  if (!payload) {
    return '用户登录失效'
  }

  const response = await getConversationMessages(parsedId, input, payload.uid)
  return response
}
