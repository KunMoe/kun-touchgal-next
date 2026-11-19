import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { kunParseDeleteQuery } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import {
  deleteKunTokenSession,
  getKunLoginSessions
} from '~/server/auth/session'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { revokeLoginSessionSchema } from '~/validations/user'

export const GET = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await getKunLoginSessions(payload.uid, payload.jti)
  return NextResponse.json(response)
}

export const POST = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  // 没有凭据要写, 只按策略刷新安全戳 (刷新了的话当前会话随后重签)
  const { stamp } = await applyKunCredentialChange(prisma, {
    uid: payload.uid,
    event: 'other-sessions-revoked',
    data: {}
  })
  const { revokedOthers } = await finishKunSecurityEvent(
    payload.uid,
    'other-sessions-revoked',
    { current: payload, stamp }
  )
  return NextResponse.json({ revokedCount: revokedOthers })
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, revokeLoginSessionSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const revoked = await deleteKunTokenSession(payload.uid, input.sessionId)
  if (!revoked) {
    return NextResponse.json('登录会话不存在或已失效')
  }

  const revokedCurrent = input.sessionId === payload.jti
  if (revokedCurrent) {
    const cookie = await cookies()
    cookie.delete('kun-galgame-patch-moe-token')
  }

  return NextResponse.json({ revokedCurrent })
}
