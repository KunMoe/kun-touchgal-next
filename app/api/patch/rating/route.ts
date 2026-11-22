import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  patchRatingCreateSchema,
  patchRatingUpdateSchema
} from '~/validations/patch'
import { getPatchRating, getPatchRatingSchema } from './get'
import { createPatchRating } from './create'
import { updatePatchRating } from './update'
import { deletePatchRating } from './delete'

const ratingIdSchema = z.object({
  ratingId: z.coerce
    .number({ message: 'patch rating ID 不正确' })
    .min(1)
    .max(9999999)
})

export const GET = kunRoute.get({
  auth: 'user',
  input: getPatchRatingSchema,
  handler: ({ input, actor }) => getPatchRating(input, actor)
})

export const POST = kunRoute.post({
  auth: 'user',
  input: patchRatingCreateSchema,
  abuse: ['content.rating'],
  handler: ({ input, actor }) => createPatchRating(input, actor)
})

export const PUT = kunRoute.put({
  auth: 'user',
  input: patchRatingUpdateSchema,
  handler: ({ input, actor }) => updatePatchRating(input, actor)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  input: ratingIdSchema,
  handler: ({ input, actor }) => deletePatchRating(input, actor)
})
