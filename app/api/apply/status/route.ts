import { kunRoute } from '~/app/api/utils/kunRoute'
import { getApplyStatus } from './service'

export const GET = kunRoute.get({
  auth: 'optional',
  handler: ({ actor: payload }) => getApplyStatus(payload?.uid ?? 0)
})
