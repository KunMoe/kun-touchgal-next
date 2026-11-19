import { resourceSchema } from '~/validations/resource'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchResource } from './service'

export const GET = kunRoute.get({
  auth: 'optional',
  input: resourceSchema,
  handler: async ({ req, input }) => {
    const view = await viewerContextFromRequest(req).listView({
      personalizedByPendingResource: true
    })

    return getPatchResource(input, view)
  }
})
