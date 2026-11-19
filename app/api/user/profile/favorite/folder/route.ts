import * as z from 'zod'
import {
  createFavoriteFolderSchema,
  updateFavoriteFolderSchema
} from '~/validations/user'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { getFolders } from './get'
import { updateFolder } from './update'
import { createFolder } from './create'
import { deleteFolder } from './delete'

const folderIdSchema = z.object({
  folderId: z.coerce.number().min(1).max(9999999)
})

const patchIdSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999).optional(),
  page: z.coerce.number().min(1).max(9999999).optional(),
  limit: z.coerce.number().min(1).max(100).optional()
})

export const GET = kunRoute.get({
  auth: 'user',
  input: patchIdSchema,
  handler: async ({ input, actor: payload }) =>
    getFolders(input, payload.uid, payload.uid)
})

export const POST = kunRoute.post({
  auth: 'user',
  input: createFavoriteFolderSchema,
  handler: async ({ input, actor: payload }) => createFolder(input, payload.uid)
})

export const PUT = kunRoute.put({
  auth: 'user',
  input: updateFavoriteFolderSchema,
  handler: async ({ input, actor: payload }) => updateFolder(input, payload.uid)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  input: folderIdSchema,
  handler: async ({ input, actor: payload }) => deleteFolder(input, payload.uid)
})
