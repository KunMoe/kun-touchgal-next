import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminPaginationSchema } from '~/validations/admin'
import { getLog } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminPaginationSchema,
  handler: ({ input }) => getLog(input)
})
