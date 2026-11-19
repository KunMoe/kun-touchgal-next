import { kunRoute } from '~/app/api/utils/kunRoute'
import { getMoyuPatchResourceSchema } from '~/validations/patch'
import { getMoyuPatchResources } from './service'

export const GET = kunRoute.get({
  auth: 'public',
  input: getMoyuPatchResourceSchema,
  handler: ({ input }) => getMoyuPatchResources(input.vndbId)
})
