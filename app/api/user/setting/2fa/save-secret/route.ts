import { toDataURL } from 'qrcode'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { beginTwoFactorEnrollmentSchema } from '~/validations/user'
import { requireStepUp } from '~/server/auth/stepUp'
import { beginEnrollment } from '~/server/auth/twoFactorState'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'

export const POST = kunRoute.post({
  auth: 'user',
  order: 'auth-first',
  input: beginTwoFactorEnrollmentSchema,
  handler: async ({ req, input, actor: payload }) => {
    const stepUp = await requireStepUp(payload.uid, 'twoFactor.enroll', input, {
      ip: getRemoteIp(req.headers)
    })
    if (!stepUp.ok) {
      return stepUp.message
    }

    const key = await beginEnrollment(stepUp.passed)
    if (typeof key === 'string') {
      return key
    }
    await finishKunSecurityEvent(payload.uid, '2fa-secret-staged')

    return {
      ...key,
      qrCodeUrl: await toDataURL(key.authUrl)
    }
  }
})
