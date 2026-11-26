import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { cookies } from 'next/headers'
import {
  acquireKvLock,
  delKv,
  delKvsAndRemoveKvSetMembers,
  delKvsAndRemoveKvSetMembersIfKvEquals,
  setKvAndExpireKvIfTtlLessThan,
  getKv,
  getKvs,
  getKvSetMembers,
  releaseKvLock,
  replaceKvIfExists,
  setKvIfAbsent,
  setKvsAndAddKvSetMembers
} from '~/lib/redis'
import { kunLog } from '~/lib/log.server'
import { prisma } from '~/prisma/index'
import { toKunRole } from '~/constants/role'
import { kunCookieOptions } from './cookieOptions'
import { updateUserLastLoginTime } from './sessionActivity'
import {
  rejectOnStampMismatch,
  stampValueOf,
  tokenStampOf
} from './securityStamp'
import {
  getCachedAuthUser,
  getUserSessionCacheScope,
  getUserSessionInvalidationKv,
  invalidateUserSession,
  setCachedAuthUser
} from './sessionCache'
import type { AuthUserCache } from './sessionCache'
import type { KunActor } from '~/constants/role'
import type { LoginSession } from '~/types/api/session'

// 站点会话: 签发 (establishKunSession / mintKunSessionToken) 与解析 (resolveKunSiteSession)
// 各只有一处。令牌是 JWT, 是否有效以 Redis 里 access:token:<uid>:<jti> 是否原样存在为准,
// 解析时再从库或鉴权缓存取角色与封禁状态 (不采信令牌里的 claim)

export interface KunGalgamePayload {
  iss: string
  aud: string
  jti: string
  uid: number
  name: string
  role: number
  // 站点认证时刻 (秒): 输入凭据登录的那一刻。OIDC 的 auth_time 取它
  auth_time?: number
  // 签发时读到的安全戳 (毫秒, 库里为 null 时是 0)。之前签发的令牌没有它, 按 0 处理
  cs?: number
  iat?: number
  exp?: number
}

export interface LoginSessionMetadata {
  id: string
  userAgent: string
  ip: string
  createdAt: number
  lastActiveAt: number
}

export interface LoginSessionContext {
  userAgent?: string | null
  ip?: string | null
}

interface KunTokenSessionExtraValue {
  key: string
  value: string
  ttlSeconds?: number
}

const KUN_ACCESS_TOKEN_EXPIRES_SECONDS = 30 * 24 * 60 * 60
const LOGIN_SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000
const LOGIN_SESSION_PRUNE_SAMPLE_RATE = 100
const LOGIN_SESSION_PRUNE_INTERVAL_SECONDS = 60 * 60

const getAccessTokenKey = (uid: number, jti: string) =>
  `access:token:${uid}:${jti}`

const getLoginSessionKey = (uid: number, jti: string) =>
  `access:session:${uid}:${jti}`

const getLoginSessionsKey = (uid: number) => `access:sessions:${uid}`

const getLoginSessionTouchLockKey = (uid: number, jti: string) =>
  `access:session-touch:${uid}:${jti}`

const getLoginSessionPruneKey = (uid: number) => `access:session-prune:${uid}`

const normalizeSessionValue = (
  value: string | null | undefined,
  maxLength: number
) => {
  if (!value) {
    return ''
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value
}

const createLoginSessionMetadata = (
  jti: string,
  context?: LoginSessionContext
): LoginSessionMetadata => {
  const now = Date.now()

  return {
    id: jti,
    userAgent: normalizeSessionValue(context?.userAgent, 1000),
    ip: normalizeSessionValue(context?.ip, 100),
    createdAt: now,
    lastActiveAt: now
  }
}

const parseLoginSessionMetadata = (value: string | null) => {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Partial<LoginSessionMetadata>
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt) ||
      typeof parsed.lastActiveAt !== 'number' ||
      !Number.isFinite(parsed.lastActiveAt)
    ) {
      return null
    }

    return {
      id: parsed.id,
      userAgent:
        typeof parsed.userAgent === 'string'
          ? normalizeSessionValue(parsed.userAgent, 1000)
          : '',
      ip:
        typeof parsed.ip === 'string'
          ? normalizeSessionValue(parsed.ip, 100)
          : '',
      createdAt: parsed.createdAt,
      lastActiveAt: parsed.lastActiveAt
    }
  } catch {
    return null
  }
}

const getTokenTtlSeconds = (payload: KunGalgamePayload) => {
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    return KUN_ACCESS_TOKEN_EXPIRES_SECONDS
  }

  const ttl = payload.exp - Math.floor(Date.now() / 1000)
  return ttl > 0 ? Math.min(ttl, KUN_ACCESS_TOKEN_EXPIRES_SECONDS) : 0
}

const setKunTokenSession = async (
  payload: KunGalgamePayload,
  token: string,
  metadata: LoginSessionMetadata,
  ttlSeconds: number,
  extraValue?: KunTokenSessionExtraValue
) => {
  const values: KunTokenSessionExtraValue[] = [
    {
      key: getAccessTokenKey(payload.uid, payload.jti),
      value: token,
      ttlSeconds
    },
    {
      key: getLoginSessionKey(payload.uid, payload.jti),
      value: JSON.stringify(metadata),
      ttlSeconds
    }
  ]
  if (extraValue) {
    values.push(extraValue)
  }

  await setKvsAndAddKvSetMembers(values, {
    key: getLoginSessionsKey(payload.uid),
    members: [payload.jti],
    setTtlSeconds: ttlSeconds
  })
}

const cleanupLoginSessions = async (uid: number, sessionIds: string[]) => {
  if (sessionIds.length === 0) {
    return
  }

  await delKvsAndRemoveKvSetMembers(
    sessionIds.flatMap((sessionId) => [
      getAccessTokenKey(uid, sessionId),
      getLoginSessionKey(uid, sessionId)
    ]),
    getLoginSessionsKey(uid),
    sessionIds
  )
}

const pruneStaleLoginSessions = async (uid: number) => {
  const sessionIds = await getKvSetMembers(getLoginSessionsKey(uid))
  if (sessionIds.length === 0) {
    return
  }

  const tokens = await getKvs(
    sessionIds.map((sessionId) => getAccessTokenKey(uid, sessionId))
  )
  const staleSessionIds = sessionIds.filter((_, index) => !tokens[index])
  await cleanupLoginSessions(uid, staleSessionIds)
}

const maybePruneStaleLoginSessions = async (uid: number) => {
  if (Math.floor(Math.random() * LOGIN_SESSION_PRUNE_SAMPLE_RATE) !== 0) {
    return
  }

  const shouldPrune = await setKvIfAbsent(
    getLoginSessionPruneKey(uid),
    '1',
    LOGIN_SESSION_PRUNE_INTERVAL_SECONDS
  )
  if (!shouldPrune) {
    return
  }

  try {
    await pruneStaleLoginSessions(uid)
  } catch (error) {
    await delKv(getLoginSessionPruneKey(uid)).catch(() => undefined)
    throw error
  }
}

const touchLoginSession = async (
  uid: number,
  jti: string,
  metadata: LoginSessionMetadata,
  ttlSeconds: number
) => {
  if (ttlSeconds <= 0) {
    return
  }

  const now = Date.now()
  if (now - metadata.lastActiveAt < LOGIN_SESSION_TOUCH_INTERVAL_MS) {
    return
  }

  const sessionKey = getLoginSessionKey(uid, jti)
  const lockToken = await acquireKvLock(getLoginSessionTouchLockKey(uid, jti))
  if (!lockToken) {
    return
  }

  try {
    const currentMetadata = parseLoginSessionMetadata(await getKv(sessionKey))
    if (
      !currentMetadata ||
      currentMetadata.id !== jti ||
      now - currentMetadata.lastActiveAt < LOGIN_SESSION_TOUCH_INTERVAL_MS
    ) {
      return
    }

    await setKvAndExpireKvIfTtlLessThan(
      sessionKey,
      JSON.stringify({ ...currentMetadata, lastActiveAt: now }),
      ttlSeconds,
      getLoginSessionsKey(uid),
      ttlSeconds
    )
  } finally {
    await releaseKvLock(getLoginSessionTouchLockKey(uid, jti), lockToken)
  }
}

const KUN_AUTH_TOKEN_COOKIE = 'kun-galgame-patch-moe-token'

export const KUN_BANNED_LOGIN_MESSAGE =
  '该用户已被封禁, 如果您觉得有任何问题, 请联系我们'

const nowSeconds = () => Math.floor(Date.now() / 1000)

// 签出一个站点会话令牌并一次写入 token、会话元数据与会话缓存版本键 (一段 Lua):
// 版本键随签发轮换, 新会话不会读到签发之前写入的鉴权缓存。全仓只有这里调 jwt.sign 签会话令牌
const issueKunSessionToken = async (
  subject: {
    id: number
    name: string
    role: number
    security_stamp: Date | null
  },
  context?: LoginSessionContext,
  authTime = nowSeconds()
) => {
  const payload: KunGalgamePayload = {
    iss: process.env.JWT_ISS!,
    aud: process.env.JWT_AUD!,
    jti: randomUUID(),
    uid: subject.id,
    name: subject.name,
    role: subject.role,
    auth_time: authTime,
    // 取自校验凭据时读到的那一行: 读完之后凭据被改了, 这张令牌一出生就对不上
    cs: stampValueOf(subject.security_stamp)
  }

  const token = jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: KUN_ACCESS_TOKEN_EXPIRES_SECONDS
  })
  await setKunTokenSession(
    payload,
    token,
    createLoginSessionMetadata(payload.jti, context),
    KUN_ACCESS_TOKEN_EXPIRES_SECONDS,
    getUserSessionInvalidationKv(payload.uid)
  )
  void pruneStaleLoginSessions(payload.uid).catch(() => undefined)

  return { token, jti: payload.jti }
}

// 安全戳刷新之后保留当前会话 (securityEvents 的 current: 'keep'): 同一个会话 (jti)、同一个
// 认证时刻与到期时刻, 只换上新戳, 覆盖 Redis 里的令牌并写回 cookie。会话元数据原样保留。
// 只覆盖仍然存在的会话: 这个请求通过鉴权之后会话若已被吊销 (另一处的重置密码、退出其它设备),
// 就不能借重签把它写回来, 而是清掉 cookie 返回 false。返回是否重签成功
export const reissueKunSessionToken = async (
  current: KunGalgamePayload,
  stamp: Date
) => {
  const cookie = await cookies()
  const ttlSeconds = getTokenTtlSeconds(current)
  if (ttlSeconds <= 0) {
    cookie.delete(KUN_AUTH_TOKEN_COOKIE)
    return false
  }
  const payload: KunGalgamePayload = {
    iss: current.iss,
    aud: current.aud,
    jti: current.jti,
    uid: current.uid,
    name: current.name,
    role: current.role,
    auth_time: current.auth_time ?? current.iat,
    cs: stampValueOf(stamp),
    exp: current.exp
  }
  const token = jwt.sign(payload, process.env.JWT_SECRET!)
  const replaced = await replaceKvIfExists(
    getAccessTokenKey(current.uid, current.jti),
    token,
    ttlSeconds
  )
  if (!replaced) {
    cookie.delete(KUN_AUTH_TOKEN_COOKIE)
    return false
  }

  cookie.set(KUN_AUTH_TOKEN_COOKIE, token, kunCookieOptions(ttlSeconds))
  return true
}

export interface KunSessionSubject {
  id: number
  name: string
  role: number
  status: number
  security_stamp: Date | null
}

export type EstablishKunSessionResult =
  { ok: true } | { ok: false; message: string }

// 凭据校验通过之后建立站点会话的唯一入口 (登录、2FA 第二步、注册): 签发令牌、写 cookie、
// 记登录时间。subject 是校验凭据时读到的那一行; 封禁的账号在这里拒绝,
// 调用方不必各自再判 (2FA 第二步曾不复核封禁, 注册曾不记登录时间)
export const establishKunSession = async (
  subject: KunSessionSubject,
  context: LoginSessionContext
): Promise<EstablishKunSessionResult> => {
  if (subject.status === 2) {
    return { ok: false, message: KUN_BANNED_LOGIN_MESSAGE }
  }

  const { token } = await issueKunSessionToken(subject, context)
  const cookie = await cookies()
  cookie.set(
    KUN_AUTH_TOKEN_COOKIE,
    token,
    kunCookieOptions(KUN_ACCESS_TOKEN_EXPIRES_SECONDS)
  )
  await updateUserLastLoginTime(subject.id)
  return { ok: true }
}

// 脚本与测试工具用: 不经凭据校验、不写 cookie, 直接为某个账号签一个会话令牌
export const mintKunSessionToken = async (
  uid: number,
  context?: LoginSessionContext
) => {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      id: true,
      name: true,
      role: true,
      status: true,
      security_stamp: true
    }
  })
  if (!user || user.status === 2) {
    throw new Error(`用户 ${uid} 不存在或已被封禁`)
  }
  return issueKunSessionToken(user, context)
}

export const generateKunStatelessToken = (
  payload: Record<string, string | number | boolean>,
  expire: number
) => {
  const token = jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: expire
  })
  return token
}

export type KunSiteSession =
  | {
      kind: 'authenticated'
      payload: KunGalgamePayload & KunActor
      user: AuthUserCache
    }
  | { kind: 'anonymous' }
  | { kind: 'unavailable'; cause: unknown }

const ANONYMOUS_SITE_SESSION: KunSiteSession = Object.freeze({
  kind: 'anonymous'
})

// 验签与形状校验: 不过就是匿名 (伪造、过期、别的密钥签的), 不是基础设施故障。
// 只验签、不查 Redis 与库: 不能当作「已登录」, 只用于「这张 cookie 是谁签的」(依赖方登出)
export const decodeKunSessionToken = (token: string) => {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!, {
      issuer: process.env.JWT_ISS!,
      audience: process.env.JWT_AUD!
    }) as KunGalgamePayload
    return typeof payload.uid === 'number' && typeof payload.jti === 'string'
      ? payload
      : null
  } catch {
    return null
  }
}

// 鉴权缓存命中就不读库; 缓存读失败按未命中处理 (降级), 读库失败往外抛 (不可用)
const loadAuthUser = async (uid: number) => {
  const scope = await getUserSessionCacheScope(uid).catch(() => null)
  const cached = scope
    ? await getCachedAuthUser(uid, scope).catch(() => null)
    : null
  if (cached) {
    return cached
  }

  const row = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      id: true,
      name: true,
      role: true,
      status: true,
      blocked_tag_ids: true,
      security_stamp: true
    }
  })
  if (!row) {
    return null
  }
  const { security_stamp, ...rest } = row
  const user: AuthUserCache = {
    ...rest,
    securityStamp: stampValueOf(security_stamp)
  }
  if (user.status !== 2 && scope) {
    await setCachedAuthUser(uid, user, scope).catch(() => undefined)
  }
  return user
}

// 站点会话的唯一解析器。三态按位置判定, 不按错误类型 (ioredis 与 Prisma adapter 的错误类
// 没有稳定的公共基类): 令牌本身不成立、Redis 已答复但对不上、库里查无此人或已封禁 → 匿名;
// 验签之后任何没被降级吸收的异常 (Redis / 库不可用) → 不可用。不可用永远不会被当成已认证
export const resolveKunSiteSession = async (
  token: string
): Promise<KunSiteSession> => {
  if (!token) {
    return ANONYMOUS_SITE_SESSION
  }
  const payload = decodeKunSessionToken(token)
  if (!payload) {
    return ANONYMOUS_SITE_SESSION
  }

  try {
    const [redisToken, metadataValue] = await getKvs([
      getAccessTokenKey(payload.uid, payload.jti),
      getLoginSessionKey(payload.uid, payload.jti)
    ])
    if (redisToken !== token) {
      return ANONYMOUS_SITE_SESSION
    }
    const metadata = parseLoginSessionMetadata(metadataValue)
    if (!metadata || metadata.id !== payload.jti) {
      await cleanupLoginSessions(payload.uid, [payload.jti]).catch(
        () => undefined
      )
      return ANONYMOUS_SITE_SESSION
    }

    await touchLoginSession(
      payload.uid,
      payload.jti,
      metadata,
      getTokenTtlSeconds(payload)
    ).catch(() => undefined)
    await maybePruneStaleLoginSessions(payload.uid).catch(() => undefined)

    const user = await loadAuthUser(payload.uid)
    if (!user || user.status === 2) {
      // 库给出的是正面证据, 删不掉会话也不改变结论: 这个分支不写鉴权缓存, 下次照样查库拒绝
      await deleteKunToken(payload.uid).catch((error) =>
        kunLog(
          'auth.session_revoke_failed',
          { reason: 'user_banned', uid: payload.uid },
          error
        )
      )
      return ANONYMOUS_SITE_SESSION
    }

    // 令牌签发之后凭据或安全属性变过 (安全戳刷新了): 这张令牌作废, 删掉这个会话。
    // 按值相等比较: 在途登录在改密之后才写入会话, 只比签发时刻拦不住它
    const tokenStamp = tokenStampOf(payload)
    if (tokenStamp !== user.securityStamp) {
      const tokenKey = getAccessTokenKey(payload.uid, payload.jti)
      // 同一会话的并发请求: 重签已把存储里的令牌换成新的, 这个请求手里还是重签之前的 cookie。
      // 这是重签的正常竞态, 不记成可疑的不一致
      const superseded = (await getKv(tokenKey)) !== token
      if (
        rejectOnStampMismatch(
          'site',
          {
            uid: payload.uid,
            jti: payload.jti,
            tokenStamp,
            userStamp: user.securityStamp
          },
          { quiet: superseded }
        )
      ) {
        // 只在存储里仍是这张令牌时才删: 与重签交错时不误删刚重签的会话
        await delKvsAndRemoveKvSetMembersIfKvEquals(
          tokenKey,
          token,
          [tokenKey, getLoginSessionKey(payload.uid, payload.jti)],
          getLoginSessionsKey(payload.uid),
          [payload.jti]
        ).catch(() => undefined)
        return ANONYMOUS_SITE_SESSION
      }
    }

    // KunActor 的唯一构造点: 角色取自库或鉴权缓存 (不采信 JWT 里的 claim), 域外的值
    // 回落为普通用户。别处要拿操作者只能从这里往下传, 不能自己拼
    const actor = {
      ...payload,
      name: user.name,
      role: toKunRole(user.role)
    } as KunGalgamePayload & KunActor
    return { kind: 'authenticated', payload: actor, user }
  } catch (cause) {
    return { kind: 'unavailable', cause }
  }
}

// 授权一侧 (路由、页面、视角): 只认已认证, 匿名与不可用一律当未登录 (fail-closed)
export const verifyKunTokenWithUser = async (token: string) => {
  const session = await resolveKunSiteSession(token)
  return session.kind === 'authenticated'
    ? { payload: session.payload, user: session.user }
    : null
}

export const getKunLoginSessions = async (
  uid: number,
  currentJti: string
): Promise<LoginSession[]> => {
  const sessionIds = await getKvSetMembers(getLoginSessionsKey(uid))
  if (sessionIds.length === 0) {
    return []
  }

  const [tokens, metadataValues] = await Promise.all([
    getKvs(sessionIds.map((sessionId) => getAccessTokenKey(uid, sessionId))),
    getKvs(sessionIds.map((sessionId) => getLoginSessionKey(uid, sessionId)))
  ])

  const staleSessionIds: string[] = []
  const sessions: LoginSession[] = []
  for (let i = 0; i < sessionIds.length; i++) {
    const sessionId = sessionIds[i]
    const metadata = parseLoginSessionMetadata(metadataValues[i])

    if (!tokens[i] || !metadata || metadata.id !== sessionId) {
      staleSessionIds.push(sessionId)
      continue
    }

    sessions.push({
      ...metadata,
      isCurrent: sessionId === currentJti
    })
  }

  if (staleSessionIds.length > 0) {
    await cleanupLoginSessions(uid, staleSessionIds)
  }

  return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

export const deleteKunTokenSession = async (uid: number, jti: string) => {
  const token = await getKv(getAccessTokenKey(uid, jti))
  if (!token) {
    return false
  }

  await cleanupLoginSessions(uid, [jti])
  return true
}

export const deleteOtherKunTokenSessions = async (
  uid: number,
  currentJti: string
) => {
  const sessionIds = await getKvSetMembers(getLoginSessionsKey(uid))
  if (sessionIds.length === 0) {
    return 0
  }

  const tokens = await getKvs(
    sessionIds.map((sessionId) => getAccessTokenKey(uid, sessionId))
  )
  const staleSessionIds: string[] = []
  const sessionIdsToDelete: string[] = []

  for (let i = 0; i < sessionIds.length; i++) {
    const sessionId = sessionIds[i]
    if (!tokens[i]) {
      staleSessionIds.push(sessionId)
    } else if (sessionId !== currentJti) {
      sessionIdsToDelete.push(sessionId)
    }
  }

  if (sessionIdsToDelete.length === 0 && staleSessionIds.length === 0) {
    return 0
  }

  await cleanupLoginSessions(uid, [...sessionIdsToDelete, ...staleSessionIds])
  return sessionIdsToDelete.length
}

// 只删读到的那些会话, 集合里只摘掉这些成员 (不删整个集合键): 读与删之间新写入的会话
// 留在集合里, 会话列表看得到、还能再吊销。删整个键会把它变成列表里看不见的孤儿 (X07-06)
export const deleteKunToken = async (uid: number) => {
  const sessionIds = await getKvSetMembers(getLoginSessionsKey(uid))
  await Promise.all([
    cleanupLoginSessions(uid, sessionIds),
    invalidateUserSession(uid)
  ])
}
