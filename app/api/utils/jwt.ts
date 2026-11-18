import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import {
  acquireKvLock,
  delKv,
  delKvs,
  delKvsAndRemoveKvSetMembers,
  setKvAndExpireKvIfTtlLessThan,
  getKv,
  getKvs,
  getKvSetMembers,
  releaseKvLock,
  setKvIfAbsent,
  setKvsAndAddKvSetMembers
} from '~/lib/redis'
import { prisma } from '~/prisma/index'
import {
  getCachedAuthUser,
  getUserSessionCacheScope,
  getUserSessionInvalidationKv,
  invalidateUserSession,
  setCachedAuthUser
} from '~/app/api/user/session/cache'
import { toKunRole } from '~/constants/role'
import type { KunActor } from '~/constants/role'
import type { LoginSession } from '~/types/api/session'

export interface KunGalgameStatelessPayload {
  require2FA: boolean
  id: number
  jti: string
}

export interface KunGalgamePayload {
  iss: string
  aud: string
  jti: string
  uid: number
  name: string
  role: number
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

const getLegacyAccessTokenKey = (uid: number) => `access:token:${uid}`

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

export const generateKunToken = async (
  uid: number,
  name: string,
  role: number,
  expire: string,
  context?: LoginSessionContext
) => {
  const payload: KunGalgamePayload = {
    iss: process.env.JWT_ISS!,
    aud: process.env.JWT_AUD!,
    jti: randomUUID(),
    uid,
    name,
    role
  }

  const token = jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: expire
  } as jwt.SignOptions)
  await setKunTokenSession(
    payload,
    token,
    createLoginSessionMetadata(payload.jti, context),
    KUN_ACCESS_TOKEN_EXPIRES_SECONDS,
    getUserSessionInvalidationKv(payload.uid)
  )
  void pruneStaleLoginSessions(payload.uid).catch(() => undefined)

  return token
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

export const verifyKunTokenPayload = async (refreshToken: string) => {
  if (!refreshToken) {
    return null
  }

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_SECRET!, {
      issuer: process.env.JWT_ISS!,
      audience: process.env.JWT_AUD!
    }) as KunGalgamePayload
    if (typeof payload.uid !== 'number' || typeof payload.jti !== 'string') {
      return null
    }

    const [redisToken, metadataValue] = await getKvs([
      getAccessTokenKey(payload.uid, payload.jti),
      getLoginSessionKey(payload.uid, payload.jti)
    ])
    if (redisToken === refreshToken) {
      const metadata = parseLoginSessionMetadata(metadataValue)
      if (!metadata || metadata.id !== payload.jti) {
        await cleanupLoginSessions(payload.uid, [payload.jti]).catch(
          () => undefined
        )
        return null
      }

      await touchLoginSession(
        payload.uid,
        payload.jti,
        metadata,
        getTokenTtlSeconds(payload)
      ).catch(() => undefined)
      await maybePruneStaleLoginSessions(payload.uid).catch(() => undefined)
      return payload
    }

    const legacyToken = await getKv(getLegacyAccessTokenKey(payload.uid))
    if (legacyToken !== refreshToken) {
      return null
    }

    const ttlSeconds = getTokenTtlSeconds(payload)
    if (ttlSeconds <= 0) {
      return null
    }

    await setKunTokenSession(
      payload,
      refreshToken,
      createLoginSessionMetadata(payload.jti),
      ttlSeconds
    )
    await delKv(getLegacyAccessTokenKey(payload.uid))
    await maybePruneStaleLoginSessions(payload.uid).catch(() => undefined)

    return payload
  } catch {
    return null
  }
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

const verifyAndLoadUser = async (refreshToken: string) => {
  try {
    const payload = await verifyKunTokenPayload(refreshToken)

    if (!payload) {
      return null
    }

    const scope = await getUserSessionCacheScope(payload.uid).catch(() => null)
    const cached = scope
      ? await getCachedAuthUser(payload.uid, scope).catch(() => null)
      : null

    const user =
      cached ??
      (await prisma.user.findUnique({
        where: { id: payload.uid },
        select: {
          id: true,
          name: true,
          role: true,
          status: true,
          blocked_tag_ids: true
        }
      }))
    if (!user || user.status === 2) {
      await deleteKunToken(payload.uid)
      return null
    }

    if (!cached && scope) {
      await setCachedAuthUser(payload.uid, user, scope).catch(() => undefined)
    }

    // KunActor 的唯一构造点: 角色取自库或鉴权缓存 (不采信 JWT 里的 claim), 域外的值
    // 回落为普通用户。别处要拿操作者只能从这里往下传, 不能自己拼
    const actor = {
      ...payload,
      name: user.name,
      role: toKunRole(user.role)
    } as KunGalgamePayload & KunActor
    return { payload: actor, user }
  } catch (error) {
    return null
  }
}

export const verifyKunToken = async (refreshToken: string) => {
  return (await verifyAndLoadUser(refreshToken))?.payload ?? null
}

export const verifyKunTokenWithUser = async (refreshToken: string) => {
  return verifyAndLoadUser(refreshToken)
}

export const deleteKunToken = async (uid: number) => {
  const sessionIds = await getKvSetMembers(getLoginSessionsKey(uid))
  await Promise.all([
    delKvs([
      getLegacyAccessTokenKey(uid),
      getLoginSessionsKey(uid),
      ...sessionIds.flatMap((sessionId) => [
        getAccessTokenKey(uid, sessionId),
        getLoginSessionKey(uid, sessionId)
      ])
    ]),
    invalidateUserSession(uid)
  ])
}
