import 'server-only'

import { getViewerContext } from '~/server/viewer/fromHeaders'
import { getHomeData } from '~/app/api/home/service'

export const kunGetActions = async () => {
  const ctx = await getViewerContext()
  const view = await ctx.listView({ personalizedByPendingResource: true })
  const response = await getHomeData(view)
  return response
}
