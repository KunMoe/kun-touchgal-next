import { kunRoute } from '~/app/api/utils/kunRoute'
import { getMessageSchema } from '~/validations/message'
import { getMessage } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  input: getMessageSchema,
  handler: async ({ input, actor: payload }) => getMessage(input, payload.uid)
})
