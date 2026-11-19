import type { MessageUnreadStatus } from './message'

// 登录、注册、2FA 第二步与 /api/user/session 回给客户端的用户状态 (客户端存进 userStore)
export interface UserState {
  uid: number
  name: string
  avatar: string
  bio: string
  moemoepoint: number
  role: number
  dailyCheckIn: number
  dailyImageLimit: number
  dailyUploadLimit: number
  enableEmailNotice: boolean
  allowPrivateMessage: boolean
  blockedTagIds: number[]

  enableRedirect: boolean
  excludedDomains: string[]
  delaySeconds: number
}

// 登录第一步通过、等待 2FA 第二步时的临时令牌载荷 (cookie kun-galgame-patch-moe-2fa-token)
export interface KunGalgameStatelessPayload {
  require2FA: boolean
  id: number
  jti: string
  // 第一步校验密码时读到的安全戳 (毫秒); 第二步与它自己读到的那一行比较
  cs?: number
}

export interface UserSession {
  user: UserState
  unread: MessageUnreadStatus
}

export interface LoginSession {
  id: string
  userAgent: string
  ip: string
  createdAt: number
  lastActiveAt: number
  isCurrent: boolean
}

export interface RevokeLoginSessionResponse {
  revokedCurrent: boolean
}

export interface RevokeOtherLoginSessionsResponse {
  revokedCount: number
}
