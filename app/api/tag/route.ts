import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  createTagSchema,
  getTagByIdSchema,
  updateTagSchema
} from '~/validations/tag'
import { createTag } from './create'
import { updateTag } from './update'
import { getTagById } from './get'
import { deleteTag } from './delete'

const tagIdSchema = z.object({
  tagId: z.coerce.number().min(1).max(9999999)
})

export const GET = kunRoute.get({
  auth: 'public',
  input: getTagByIdSchema,
  handler: ({ input }) => getTagById(input)
})

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'tag.manage',
  input: createTagSchema,
  handler: ({ input, actor }) => createTag(input, actor.uid)
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'tag.manage',
  input: updateTagSchema,
  handler: ({ input }) => updateTag(input)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'tag.manage',
  input: tagIdSchema,
  handler: ({ input }) => deleteTag(input.tagId)
})
