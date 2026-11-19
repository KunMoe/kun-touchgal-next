import { kunRoute } from '~/app/api/utils/kunRoute'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { enableUser2FASchema } from '~/validations/user'
import { confirmEnrollment } from '~/server/auth/twoFactorState'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'
import { tokenStampOf } from '~/server/auth/securityStamp'

export const POST = kunRoute.post({
  auth: 'user',
  input: enableUser2FASchema,
  handler: async ({ req, input, actor: payload }) => {
    const result = await confirmEnrollment(payload.uid, input.token, {
      ip: getRemoteIp(req.headers),
      currentStamp: tokenStampOf(payload)
    })
    if (typeof result === 'string') {
      return result
    }

    await finishKunSecurityEvent(payload.uid, '2fa-enabled', {
      current: payload,
      stamp: result.stamp
    })
    return { backupCode: result.backupCode }
  }
})
