import { kunRoute } from '~/app/api/utils/kunRoute'
import { getPatchByTagSchema } from '~/validations/tag'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchByTag } from './service'

export const GET = kunRoute.get({
  auth: 'optional',
  input: getPatchByTagSchema,
  handler: async ({ req, input }) => {
    const view = await viewerContextFromRequest(req).listView()

    return getPatchByTag(input, view)
  }
})
