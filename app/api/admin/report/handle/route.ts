import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminHandleReportSchema } from '~/validations/admin'
import { handleReport } from './service'

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'admin.access',
  input: adminHandleReportSchema,
  handler: ({ input, actor }) => handleReport(input, actor.uid)
})
