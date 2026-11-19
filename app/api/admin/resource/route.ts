import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  adminDeleteResourceSchema,
  adminResourcePaginationSchema
} from '~/validations/admin'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchResource } from './get'
import { patchResourceUpdateSchema } from '~/validations/patch'
import { updatePatchResource } from './update'
import { deleteResource } from './delete'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminResourcePaginationSchema,
  handler: async ({ req, input }) => {
    const { contentLimit } = await viewerContextFromRequest(req).visibility()

    return getPatchResource(input, contentLimit)
  }
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: patchResourceUpdateSchema,
  handler: ({ input, actor }) => updatePatchResource(input, actor)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'admin.access',
  input: adminDeleteResourceSchema,
  handler: ({ input, actor }) => deleteResource(input, actor.uid)
})
