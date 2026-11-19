import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminUpdateCommentShadowBanSchema } from '~/validations/admin'
import { updateCommentShadowBan } from './shadowBan'

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminUpdateCommentShadowBanSchema,
  handler: ({ input, actor }) => updateCommentShadowBan(input, actor.uid)
})
