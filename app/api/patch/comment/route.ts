import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  patchCommentCreateSchema,
  patchCommentUpdateSchema,
  getPatchCommentSchema
} from '~/validations/patch'
import { getPatchComment } from './get'
import { createPatchComment } from './create'
import { updateComment } from './update'
import { deleteComment } from './delete'
import * as z from 'zod'
import { kunId } from '~/validations/primitives'

const commentIdSchema = z.object({
  commentId: kunId('评论 ID')
})

export const GET = kunRoute.get({
  auth: 'user',
  legacyDeny: { unauthenticated: '用户登录失效' },
  input: getPatchCommentSchema,
  handler: ({ input, actor }) => getPatchComment(input, actor)
})

export const POST = kunRoute.post({
  auth: 'user',
  input: patchCommentCreateSchema,
  abuse: ['content.comment'],
  handler: ({ input, actor }) => createPatchComment(input, actor)
})

export const PUT = kunRoute.put({
  auth: 'user',
  input: patchCommentUpdateSchema,
  handler: ({ input, actor }) => updateComment(input, actor)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  input: commentIdSchema,
  handler: ({ input, actor }) => deleteComment(input, actor)
})
