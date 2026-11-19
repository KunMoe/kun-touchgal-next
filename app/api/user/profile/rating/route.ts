import { kunRoute } from '~/app/api/utils/kunRoute'
import { getUserInfoSchema } from '~/validations/user'
import { getUserPatchRating } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  legacyDeny: { unauthenticated: '用户登录失效' },
  input: getUserInfoSchema,
  handler: async ({ input, actor: payload }) =>
    getUserPatchRating(input, payload)
})
