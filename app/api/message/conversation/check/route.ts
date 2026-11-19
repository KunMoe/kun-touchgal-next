import { kunRoute } from '~/app/api/utils/kunRoute'
import { createConversationSchema } from '~/validations/conversation'
import { checkConversation } from '../service'

export const GET = kunRoute.get({
  auth: 'user',
  input: createConversationSchema,
  handler: async ({ input, actor: payload }) =>
    checkConversation(input, payload)
})
