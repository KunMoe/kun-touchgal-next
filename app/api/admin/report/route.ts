import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminReportPaginationSchema } from '~/validations/admin'
import { getReport } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminReportPaginationSchema,
  handler: ({ input }) => getReport(input)
})
