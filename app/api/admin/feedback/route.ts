import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminFeedbackPaginationSchema } from '~/validations/admin'
import { getFeedback } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminFeedbackPaginationSchema,
  handler: ({ input }) => getFeedback(input)
})
