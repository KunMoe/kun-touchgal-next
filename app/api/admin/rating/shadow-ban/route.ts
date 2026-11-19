import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminUpdateRatingShadowBanSchema } from '~/validations/admin'
import { updateRatingShadowBan } from './shadowBan'

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminUpdateRatingShadowBanSchema,
  handler: ({ input, actor }) => updateRatingShadowBan(input, actor.uid)
})
