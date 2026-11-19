import { prisma } from '~/prisma/index'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { allowPrivateMessageSchema } from '~/validations/user'
import { invalidateUserSession } from '~/app/api/user/session/cache'

const updateAllowPrivateMessage = async (
  uid: number,
  allowPrivateMessage: boolean
) => {
  const { count } = await prisma.user.updateMany({
    where: { id: uid },
    data: { allow_private_message: allowPrivateMessage }
  })
  if (count === 0) {
    return '未找到用户'
  }

  await invalidateUserSession(uid)
  return {}
}

export const POST = kunRoute.post({
  auth: 'user',
  input: allowPrivateMessageSchema,
  handler: async ({ input, actor: payload }) =>
    updateAllowPrivateMessage(payload.uid, input.allowPrivateMessage)
})
