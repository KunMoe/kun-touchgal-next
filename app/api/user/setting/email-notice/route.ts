import { prisma } from '~/prisma/index'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { enableEmailNoticeSchema } from '~/validations/user'
import { invalidateUserSession } from '~/app/api/user/session/cache'

const updateEmailNotice = async (uid: number, enableEmailNotice: boolean) => {
  const { count } = await prisma.user.updateMany({
    where: { id: uid },
    data: { enable_email_notice: enableEmailNotice }
  })
  if (count === 0) {
    return '未找到用户'
  }

  await invalidateUserSession(uid)
  return {}
}

export const POST = kunRoute.post({
  auth: 'user',
  input: enableEmailNoticeSchema,
  handler: async ({ input, actor: payload }) =>
    updateEmailNotice(payload.uid, input.enableEmailNotice)
})
