import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminGalgamePaginationSchema } from '~/validations/admin'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getGalgame } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminGalgamePaginationSchema,
  handler: async ({ req, input }) => {
    const { contentLimit } = await viewerContextFromRequest(req).visibility()

    return getGalgame(input, contentLimit)
  }
})
