import { prisma } from '~/prisma/index'
import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { hashPassword } from '~/server/auth/algorithm'
import { requireStepUp } from '~/server/auth/stepUp'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { passwordSchema } from '~/validations/user'
import type { NextRequest } from 'next/server'
import type { KunRoutePayload } from '~/app/api/utils/kunRoute'

const updatePassword = async (
  req: NextRequest,
  input: z.infer<typeof passwordSchema>,
  payload: KunRoutePayload
) => {
  const ip = getRemoteIp(req.headers)
  if (!ip) {
    return '读取请求头失败'
  }

  const stepUp = await requireStepUp(
    payload.uid,
    'password.change',
    { currentPassword: input.oldPassword },
    { ip }
  )
  if (!stepUp.ok) {
    return stepUp.message
  }

  const hashedPassword = await hashPassword(input.newPassword)

  const { count, stamp } = await applyKunCredentialChange(prisma, {
    uid: payload.uid,
    event: 'password-changed',
    data: { password: hashedPassword }
  })
  if (!count) {
    return '用户不存在'
  }

  // 登出全部会话 (含当前这个) 并清 cookie
  await finishKunSecurityEvent(payload.uid, 'password-changed', {
    current: payload,
    stamp
  })
}

export const POST = kunRoute.post({
  auth: 'user',
  input: passwordSchema,
  handler: async ({ req, input, actor }) => {
    const res = await updatePassword(req, input, actor)
    return typeof res === 'string' ? res : {}
  }
})
