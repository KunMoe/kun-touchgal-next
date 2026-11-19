import {
  adminRatingPaginationSchema,
  adminDeleteRatingSchema
} from '~/validations/admin'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { patchRatingUpdateSchema } from '~/validations/admin'
import { getRating } from './get'
import { updateRating } from './update'
import { deleteRating } from './delete'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminRatingPaginationSchema,
  handler: ({ input }) => getRating(input)
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: patchRatingUpdateSchema,
  handler: ({ input, actor }) => updateRating(input, actor)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'admin.access',
  input: adminDeleteRatingSchema,
  handler: ({ input, actor }) => deleteRating(input, actor.uid)
})
