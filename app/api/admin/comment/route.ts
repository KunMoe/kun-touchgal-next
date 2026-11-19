import {
  adminCommentPaginationSchema,
  adminDeleteCommentSchema
} from '~/validations/admin'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { patchCommentUpdateSchema } from '~/validations/patch'
import { getComment } from './get'
import { updateComment } from './update'
import { deleteComment } from './delete'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminCommentPaginationSchema,
  handler: ({ input }) => getComment(input)
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: patchCommentUpdateSchema,
  handler: ({ input, actor }) => updateComment(input, actor)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'admin.access',
  input: adminDeleteCommentSchema,
  handler: ({ input, actor }) => deleteComment(input, actor.uid)
})
