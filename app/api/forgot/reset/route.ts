import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { forgotPasswordResetSchema } from '~/validations/forgot'
import { prisma } from '~/prisma/index'
import { hashPassword } from '~/app/api/utils/algorithm'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import { getKv, delKv } from '~/lib/redis'
import {
  createForgotPasswordResetKey,
  type ForgotPasswordResetPayload
} from '~/app/api/utils/sendResetPasswordLinkEmail'

const INVALID_LINK_MESSAGE = '重置链接无效或已过期, 请重新发起重置密码请求'

const resetPassword = async (
  input: z.infer<typeof forgotPasswordResetSchema>
) => {
  if (input.newPassword !== input.confirmPassword) {
    return '两次密码输入不一致'
  }

  const resetKey = createForgotPasswordResetKey(input.token)
  const stored = await getKv(resetKey)
  if (!stored) {
    return INVALID_LINK_MESSAGE
  }
  await delKv(resetKey)

  const payload: ForgotPasswordResetPayload = JSON.parse(stored)
  const user = await prisma.user.findUnique({
    where: { id: payload.uid },
    select: { id: true, email: true }
  })
  if (!user || user.email.toLowerCase() !== payload.email.toLowerCase()) {
    return INVALID_LINK_MESSAGE
  }

  const hashedPassword = await hashPassword(input.newPassword)
  const { count } = await applyKunCredentialChange(prisma, {
    uid: user.id,
    event: 'password-reset',
    data: { password: hashedPassword }
  })
  if (!count) {
    return INVALID_LINK_MESSAGE
  }

  await finishKunSecurityEvent(user.id, 'password-reset')
}

export const POST = kunRoute.post({
  auth: 'public',
  input: forgotPasswordResetSchema,
  handler: async ({ input }) => {
    const response = await resetPassword(input)
    if (typeof response === 'string') {
      return response
    }

    return {}
  }
})
