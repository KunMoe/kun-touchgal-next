import { kunRoute } from '~/app/api/utils/kunRoute'
import { getUnreadMessageStatus } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  handler: async ({ actor: payload }) => getUnreadMessageStatus(payload.uid)
})
