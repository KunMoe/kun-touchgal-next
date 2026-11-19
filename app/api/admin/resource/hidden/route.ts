import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminUpdateResourceHiddenSchema } from '~/validations/admin'
import { updateResourceHidden } from './hidden'

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminUpdateResourceHiddenSchema,
  handler: ({ input, actor }) => updateResourceHidden(input, actor.uid)
})
