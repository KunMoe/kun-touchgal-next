import { kunRoute } from '~/app/api/utils/kunRoute'
import { getUserProfileSchema } from '~/validations/user'
import { getUserProfile } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  legacyDeny: { unauthenticated: '请先登录', unauthenticatedStatus: 401 },
  input: getUserProfileSchema,
  handler: async ({ input, actor: payload }) => getUserProfile(input, payload)
})
