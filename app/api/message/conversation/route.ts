import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  getConversationsSchema,
  createConversationSchema
} from '~/validations/conversation'
import { getConversations, getOrCreateConversation } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  input: getConversationsSchema,
  handler: async ({ input, actor: payload }) =>
    getConversations(input, payload.uid)
})

export const POST = kunRoute.post({
  auth: 'user',
  input: createConversationSchema,
  handler: async ({ input, actor: payload }) =>
    getOrCreateConversation(input, payload)
})
