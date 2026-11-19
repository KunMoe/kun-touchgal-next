import { galgameSchema } from '~/validations/galgame'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getGalgame } from './service'
export const GET = kunRoute.get({
  auth: 'optional',
  input: galgameSchema,
  handler: async ({ req, input }) => {
    const view = await viewerContextFromRequest(req).listView()

    return getGalgame(input, view)
  }
})
