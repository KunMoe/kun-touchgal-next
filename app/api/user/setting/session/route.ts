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
import { tokenStampOf } from '~/server/auth/securityStamp'
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
  const { count, stamp } = await applyKunCredentialChange(prisma, {
    uid: payload.uid,
    event: 'other-sessions-revoked',
    data: {},
    currentStamp: tokenStampOf(payload)
  })
  // 戳在这个请求通过鉴权之后被别处刷新过 (重置密码、另一台设备也点了退出其它设备):
  // 这个会话本该失效, 不能接着去删别人的会话再把自己重签回来
  if (!count) {
    return NextResponse.json('登录状态已变化, 请重新登录')
  }
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
