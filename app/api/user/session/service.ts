import { cache } from 'react'
import { cookies } from 'next/headers'
import { resolveKunSiteSession } from '~/server/auth/session'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'
import { touchUserLastActiveTime } from '~/server/auth/sessionActivity'
import { getUserStatus } from '~/app/api/user/status/service'
import { getUnreadMessageStatus } from '~/app/api/message/unread/service'
import {
  getCachedUserSession,
  getUserSessionCacheScope,
  setCachedUserSession
} from '~/server/auth/sessionCache'
import type { UserSession, UserState } from '~/types/api/session'
import type { MessageUnreadStatus } from '~/types/api/message'

const emptyUnreadStatus: MessageUnreadStatus = {
  hasUnreadNotification: false,
  hasUnreadConversation: false
}

const logSessionError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

// 模块内部的约定: 基础设施失败用异常表达, 正面否定 (用户不存在 / 已封禁) 用 null 表达,
// 到模块边界 (resolveUserSessionByToken) 一次性转成三态
const getUserState = async (uid: number): Promise<UserState | null> => {
  const scope = await getUserSessionCacheScope(uid).catch(() => null)
  const cached = scope
    ? await getCachedUserSession(uid, scope).catch(() => null)
    : null
  if (cached) {
    return cached.user
  }

  const user = await getUserStatus(uid)
  if (typeof user === 'string') {
    // 库给出的正面证据: 删不掉会话也不改变结论 (这个分支不写缓存, 下次照样查库拒绝)
    await finishKunSecurityEvent(uid, 'ban-detected').catch((error) =>
      logSessionError('Failed to revoke sessions of a missing user:', error)
    )
    return null
  }

  await touchUserLastActiveTime(uid)
  if (scope) {
    await setCachedUserSession(uid, user, scope).catch(() => undefined)
  }
  return user
}

export type UserSessionResolution =
  | { kind: 'authenticated'; session: UserSession }
  | { kind: 'anonymous' }
  | { kind: 'unavailable'; cause: unknown }

export const resolveUserSessionByToken = async (
  token: string
): Promise<UserSessionResolution> => {
  const site = await resolveKunSiteSession(token)
  if (site.kind !== 'authenticated') {
    return site
  }

  const uid = site.payload.uid
  try {
    const [user, unread] = await Promise.all([
      getUserState(uid),
      getUnreadMessageStatus(uid).catch(() => emptyUnreadStatus)
    ])
    return user
      ? { kind: 'authenticated', session: { user, unread } }
      : { kind: 'anonymous' }
  } catch (cause) {
    return { kind: 'unavailable', cause }
  }
}

const resolveCachedUserSessionByToken = cache(resolveUserSessionByToken)

// 根布局用: 会话服务不可用时与未登录一样给 null (顶栏随后由客户端的 /api/user/session 复查)
export const getServerUserSession = async (): Promise<UserSession | null> => {
  const cookieStore = await cookies()
  const token = cookieStore.get('kun-galgame-patch-moe-token')?.value
  if (!token) {
    return null
  }

  const resolution = await resolveCachedUserSessionByToken(token)
  if (resolution.kind === 'unavailable') {
    logSessionError('User session service unavailable:', resolution.cause)
    return null
  }
  return resolution.kind === 'authenticated' ? resolution.session : null
}
