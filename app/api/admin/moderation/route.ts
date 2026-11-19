import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminModerationPaginationSchema } from '~/validations/admin'
import { getModerationTasks } from './get'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminModerationPaginationSchema,
  handler: ({ input }) => getModerationTasks(input)
})
