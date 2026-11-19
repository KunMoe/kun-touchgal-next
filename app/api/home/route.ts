import { kunRoute } from '~/app/api/utils/kunRoute'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getHomeData } from './service'

export const GET = kunRoute.get({
  auth: 'optional',
  handler: async ({ req }) => {
    const view = await viewerContextFromRequest(req).listView({
      personalizedByPendingResource: true
    })

    return getHomeData(view)
  }
})
