import {
  createFavoriteFolderSchema,
  favoriteFolderIdSchema,
  getFavoriteFoldersSchema,
  updateFavoriteFolderSchema
} from '~/validations/user'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { getFolders } from './get'
import { updateFolder } from './update'
import { createFolder } from './create'
import { deleteFolder } from './delete'

export const GET = kunRoute.get({
  auth: 'user',
  input: getFavoriteFoldersSchema,
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
  input: favoriteFolderIdSchema,
  handler: async ({ input, actor: payload }) => deleteFolder(input, payload.uid)
})
