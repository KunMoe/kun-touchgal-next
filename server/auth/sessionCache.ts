import { randomUUID } from 'crypto'
import { getKv, setKv } from '~/lib/redis'
import { kunLog } from '~/lib/log.server'
import type { UserState } from '~/types/api/session'

const USER_SESSION_CACHE_TTL_SECONDS = 10 * 60
const USER_SESSION_GENERATION_KEY = 'session:user:generation'
const logSessionCacheError = (message: string, error: unknown) => {
  kunLog('cache.invalidate_failed', { ns: 'session:user', op: message }, error)
}

interface UserSessionCacheScope {
  generation: string
  version: string
}

const getUserSessionVersionKey = (uid: number) => `session:user:version:${uid}`

export const getUserSessionInvalidationKv = (uid: number) => ({
  key: getUserSessionVersionKey(uid),
  value: randomUUID()
})

const getUserSessionCacheKey = (
  uid: number,
  { generation, version }: UserSessionCacheScope
) => `session:user:${generation}:${version}:${uid}`

const getUserSessionGeneration = async () =>
  (await getKv(USER_SESSION_GENERATION_KEY)) ?? '0'

const getUserSessionVersion = async (uid: number) =>
  (await getKv(getUserSessionVersionKey(uid))) ?? '0'

export const getUserSessionCacheScope = async (
  uid: number
): Promise<UserSessionCacheScope> => {
  const [generation, version] = await Promise.all([
    getUserSessionGeneration(),
    getUserSessionVersion(uid)
  ])

  return { generation, version }
}

const parseCachedUserSession = (value: string | null): UserState | null => {
  if (!value) {
    return null
  }

  try {
    const user = JSON.parse(value) as Partial<UserState>
    if (
      typeof user.uid !== 'number' ||
      typeof user.name !== 'string' ||
      !Array.isArray(user.blockedTagIds)
    ) {
      return null
    }

    return user as UserState
  } catch {
    return null
  }
}

export const getCachedUserSession = async (
  uid: number,
  scope: UserSessionCacheScope
) => {
  const cached = await getKv(getUserSessionCacheKey(uid, scope))
  const user = parseCachedUserSession(cached)

  return user ? { user, scope } : null
}

export const setCachedUserSession = async (
  uid: number,
  user: UserState,
  scope: UserSessionCacheScope
) => {
  // key 已按 generation:version 命名空间化: 竞态下用旧 scope 写入只会落在读侧
  // 算不到的死键上并随 TTL 过期, 不产生脏读, 故无需重读 scope 做 CAS 守卫
  await setKv(
    getUserSessionCacheKey(uid, scope),
    JSON.stringify(user),
    USER_SESSION_CACHE_TTL_SECONDS
  )
}

// 鉴权热点路径 (verifyAndLoadUser) 专用的轻量用户缓存: 只存封禁判定与
// payload 覆盖需要的字段, 复用 UserState 会话缓存的 generation+version 失效,
// 与 getUserSessionByToken 路径共享同一套写路径 invalidate 接线
export interface AuthUserCache {
  id: number
  name: string
  role: number
  status: number
  blocked_tag_ids: number[]
  // 安全戳的毫秒值 (库里为 null 时是 0), 解析会话时与令牌的 cs 比较
  securityStamp: number
}

const getAuthUserCacheKey = (
  uid: number,
  { generation, version }: UserSessionCacheScope
) => `session:authuser:${generation}:${version}:${uid}`

const parseCachedAuthUser = (value: string | null): AuthUserCache | null => {
  if (!value) {
    return null
  }

  try {
    const user = JSON.parse(value) as Partial<AuthUserCache>
    if (
      typeof user.id !== 'number' ||
      typeof user.name !== 'string' ||
      typeof user.role !== 'number' ||
      typeof user.status !== 'number' ||
      !Array.isArray(user.blocked_tag_ids) ||
      // 上线之前写入的条目没有安全戳: 当作未命中回源, 不拿 undefined 去比
      typeof user.securityStamp !== 'number'
    ) {
      return null
    }

    return user as AuthUserCache
  } catch {
    return null
  }
}

export const getCachedAuthUser = async (
  uid: number,
  scope: UserSessionCacheScope
) => {
  const cached = await getKv(getAuthUserCacheKey(uid, scope))

  return parseCachedAuthUser(cached)
}

export const setCachedAuthUser = async (
  uid: number,
  user: AuthUserCache,
  scope: UserSessionCacheScope
) => {
  // 同 setCachedUserSession: 命名空间化的 key 已保证旧 scope 写入不可读, 免 CAS 重读
  await setKv(
    getAuthUserCacheKey(uid, scope),
    JSON.stringify(user),
    USER_SESSION_CACHE_TTL_SECONDS
  )
}

export const invalidateUserSession = async (uid: number) => {
  try {
    await setKv(getUserSessionVersionKey(uid), randomUUID())
  } catch (error) {
    logSessionCacheError('Failed to invalidate user session cache:', error)
  }
}

export const invalidateUserSessions = async (uids: number[]) => {
  const uniqueUids = [...new Set(uids)].filter((uid) => Number.isInteger(uid))
  if (!uniqueUids.length) {
    return
  }

  try {
    await Promise.all(
      uniqueUids.map((uid) =>
        setKv(getUserSessionVersionKey(uid), randomUUID())
      )
    )
  } catch (error) {
    logSessionCacheError('Failed to invalidate user session caches:', error)
  }
}

export const invalidateAllUserSessions = async () => {
  try {
    await setKv(USER_SESSION_GENERATION_KEY, randomUUID())
  } catch (error) {
    logSessionCacheError('Failed to invalidate all user session caches:', error)
  }
}
