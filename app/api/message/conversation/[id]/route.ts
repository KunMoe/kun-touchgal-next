import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  parseConversationId,
  getConversationMessagesSchema,
  sendPrivateMessageSchema,
  updatePrivateMessageSchema,
  deletePrivateMessageSchema
} from '~/validations/conversation'
import {
  getConversationMessages,
  sendMessage,
  updateMessage,
  deleteMessage,
  deleteConversation
} from './service'

export const GET = kunRoute.get({
  auth: 'user',
  params: ({ id }) => parseConversationId(id),
  input: getConversationMessagesSchema,
  handler: async ({ params: conversationId, input, actor: payload }) =>
    getConversationMessages(conversationId, input, payload.uid)
})

export const POST = kunRoute.post({
  auth: 'user',
  params: ({ id }) => parseConversationId(id),
  input: sendPrivateMessageSchema,
  abuse: ['message.send'],
  handler: async ({ params: conversationId, input, actor: payload }) =>
    sendMessage(conversationId, input, payload.uid)
})

export const PUT = kunRoute.put({
  auth: 'user',
  params: ({ id }) => parseConversationId(id),
  input: updatePrivateMessageSchema,
  handler: async ({ params: conversationId, input, actor: payload }) =>
    updateMessage(conversationId, input, payload.uid)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  params: ({ id }) => parseConversationId(id),
  handler: async ({ req, params: conversationId, actor: payload }) => {
    const { searchParams } = new URL(req.url)

    if (searchParams.has('messageId')) {
      const input = kunParseGetQuery(req, deletePrivateMessageSchema)
      if (typeof input === 'string') {
        return input
      }

      return deleteMessage(conversationId, input, payload.uid)
    }

    if (searchParams.get('action') !== 'conversation') {
      return '无效的删除操作类型'
    }

    return deleteConversation(conversationId, payload.uid)
  }
})
