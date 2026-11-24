import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  adminUpdateUserSchema,
  adminUserPaginationSchema
} from '~/validations/admin'
import { userUidSchema } from '~/validations/user'
import { getUserInfo } from './get'
import { updateUser } from './update'
import { deleteAccount } from '~/server/account/deleteAccount'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: adminUserPaginationSchema,
  handler: ({ input }) => getUserInfo(input)
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminUpdateUserSchema,
  handler: ({ input, actor }) => updateUser(input, actor.uid)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'admin.access',
  input: userUidSchema,
  handler: ({ input, actor }) => deleteAccount(input.uid, actor)
})
