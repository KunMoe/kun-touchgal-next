import { kunRoute } from '~/app/api/utils/kunRoute'
import { getUserInfoSchema } from '~/validations/user'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getUserPatchResource } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  legacyDeny: { unauthenticated: '用户登录失效' },
  input: getUserInfoSchema,
  handler: async ({ req, input, actor: viewer }) => {
    const visibility = await viewerContextFromRequest(req).visibility()

    return getUserPatchResource(input, visibility, viewer)
  }
})
