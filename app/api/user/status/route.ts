import { kunRoute } from '~/app/api/utils/kunRoute'
import { getUserStatus } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  legacyDeny: { unauthenticated: '用户登录失效' },
  handler: async ({ actor: payload }) => getUserStatus(payload.uid)
})
