import { jwtVerify } from 'jose/jwt/verify'
import type { KunGalgamePayload } from '~/server/auth/session'

const getSecret = () => new TextEncoder().encode(process.env.JWT_SECRET!)

export const verifyKunTokenEdge = async (token: string) => {
  if (!token) {
    return null
  }
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: process.env.JWT_ISS!,
      audience: process.env.JWT_AUD!,
      algorithms: ['HS256']
    })
    return payload as unknown as KunGalgamePayload
  } catch {
    return null
  }
}
