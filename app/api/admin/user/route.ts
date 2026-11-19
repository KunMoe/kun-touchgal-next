import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  adminUpdateUserSchema,
  adminUserPaginationSchema
} from '~/validations/admin'
import { getUserInfo } from './get'
import { updateUser } from './update'
import { deleteUser } from './delete'

const userIdSchema = z.object({
  uid: z.coerce.number({ message: '用户 ID 必须为数字' }).min(1).max(9999999)
})

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
  input: userIdSchema,
  handler: ({ input, actor }) => deleteUser(input, actor.uid)
})
