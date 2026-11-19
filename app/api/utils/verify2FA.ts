import jwt from 'jsonwebtoken'
import type { KunGalgameStatelessPayload } from '~/types/api/session'

export const verify2FA = (token: string) => {
  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET!
    ) as KunGalgameStatelessPayload

    if (
      !payload.require2FA ||
      typeof payload.id !== 'number' ||
      typeof payload.jti !== 'string' ||
      !payload.jti
    ) {
      return null
    }

    return payload
  } catch (error) {
    return null
  }
}
