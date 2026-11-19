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

const commentIdSchema = z.object({
  commentId: z.coerce
    .number({ message: '评论 ID 必须为数字' })
    .min(1)
    .max(9999999)
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
