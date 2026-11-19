import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  adminAppealPaginationSchema,
  adminHandleAppealSchema
} from '~/validations/admin'
import { getAppeals } from './get'
import { handleAppeal } from './handle'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminAppealPaginationSchema,
  handler: ({ input }) => getAppeals(input)
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminHandleAppealSchema,
  handler: ({ input, actor }) => handleAppeal(input, actor.uid)
})
