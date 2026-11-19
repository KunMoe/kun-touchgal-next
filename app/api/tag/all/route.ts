import { kunRoute } from '~/app/api/utils/kunRoute'
import { getTagSchema } from '~/validations/tag'
import { getTag } from './service'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'

export const GET = kunRoute.get({
  auth: 'user',
  input: getTagSchema,
  handler: async ({ req, input }) =>
    getTag(input, await viewerContextFromRequest(req).visibility())
})
