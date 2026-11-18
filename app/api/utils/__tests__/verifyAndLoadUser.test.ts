import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUserCache } from '~/app/api/user/session/cache'

const jti = 'j1'
const token = 'tok'

const {
  verifyMock,
  getKvsMock,
  getKvSetMembersMock,
  findUniqueMock,
  getUserSessionCacheScopeMock,
  getCachedAuthUserMock,
  setCachedAuthUserMock,
  invalidateUserSessionMock
} = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  getKvsMock: vi.fn(),
  getKvSetMembersMock: vi.fn(async () => [] as string[]),
  findUniqueMock: vi.fn(),
  getUserSessionCacheScopeMock: vi.fn(async () => ({
    generation: '0',
    version: '0'
  })),
  getCachedAuthUserMock: vi.fn<() => Promise<AuthUserCache | null>>(
    async () => null
  ),
  setCachedAuthUserMock: vi.fn(async () => undefined),
  invalidateUserSessionMock: vi.fn(async () => undefined)
}))

vi.mock('jsonwebtoken', () => ({
  default: { verify: verifyMock, sign: vi.fn(() => 'signed') }
}))

vi.mock('~/lib/redis', () => ({
  acquireKvLock: vi.fn(),
  delKv: vi.fn(),
  delKvs: vi.fn(),
  delKvsAndRemoveKvSetMembers: vi.fn(),
  setKvAndExpireKvIfTtlLessThan: vi.fn(),
  getKv: vi.fn(async () => null),
  getKvs: getKvsMock,
  getKvSetMembers: getKvSetMembersMock,
  releaseKvLock: vi.fn(),
  setKvIfAbsent: vi.fn(async () => false),
  setKvsAndAddKvSetMembers: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: findUniqueMock } }
}))

vi.mock('~/app/api/user/session/cache', () => ({
  getUserSessionInvalidationKv: vi.fn(() => ({ key: 'k', value: 'v' })),
  invalidateUserSession: invalidateUserSessionMock,
  getUserSessionCacheScope: getUserSessionCacheScopeMock,
  getCachedAuthUser: getCachedAuthUserMock,
  setCachedAuthUser: setCachedAuthUserMock
}))

import { verifyKunTokenWithUser } from '~/app/api/utils/jwt'

const now = Date.now()
const payload = {
  iss: '',
  aud: '',
  jti,
  uid: 7,
  name: 'kun',
  role: 1,
  exp: Math.floor(now / 1000) + 30 * 24 * 60 * 60
}

beforeEach(() => {
  vi.clearAllMocks()
  // Math.random 用于 maybePruneStaleLoginSessions 采样, 固定为非 0 桶跳过清理
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  verifyMock.mockReturnValue(payload)
  getKvSetMembersMock.mockResolvedValue([])
  getUserSessionCacheScopeMock.mockResolvedValue({
    generation: '0',
    version: '0'
  })
  // verifyKunTokenPayload happy path: redis token 命中 + metadata 合法且新鲜
  getKvsMock.mockResolvedValue([
    token,
    JSON.stringify({
      id: jti,
      userAgent: '',
      ip: '',
      createdAt: now,
      lastActiveAt: now
    })
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verifyAndLoadUser 用户缓存', () => {
  it('缓存命中时跳过 findUnique, 用缓存值覆盖 payload', async () => {
    getCachedAuthUserMock.mockResolvedValue({
      id: 7,
      name: 'kun-new',
      role: 2,
      status: 0,
      blocked_tag_ids: [9]
    })

    const result = await verifyKunTokenWithUser(token)

    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(setCachedAuthUserMock).not.toHaveBeenCalled()
    expect(result?.user).toEqual({
      id: 7,
      name: 'kun-new',
      role: 2,
      status: 0,
      blocked_tag_ids: [9]
    })
    expect(result?.payload).toMatchObject({ uid: 7, name: 'kun-new', role: 2 })
  })

  it('角色以库或缓存里的为准, 不采信 JWT 里的 claim; 域外的值回落为普通用户', async () => {
    verifyMock.mockReturnValue({ ...payload, role: 4 })
    getCachedAuthUserMock.mockResolvedValue({
      id: 7,
      name: 'kun',
      role: 3,
      status: 0,
      blocked_tag_ids: []
    })
    expect((await verifyKunTokenWithUser(token))?.payload.role).toBe(3)

    for (const role of [0, 5, -1]) {
      getCachedAuthUserMock.mockResolvedValue({
        id: 7,
        name: 'kun',
        role,
        status: 0,
        blocked_tag_ids: []
      })
      expect((await verifyKunTokenWithUser(token))?.payload.role).toBe(1)
    }
  })

  it('缓存命中且 status===2 时仍拒绝并注销 token, 不查库', async () => {
    getCachedAuthUserMock.mockResolvedValue({
      id: 7,
      name: 'kun',
      role: 1,
      status: 2,
      blocked_tag_ids: []
    })

    const result = await verifyKunTokenWithUser(token)

    expect(result).toBeNull()
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(7)
  })

  it('缓存未命中时回源数据库并写入缓存', async () => {
    getCachedAuthUserMock.mockResolvedValue(null)
    const dbUser = {
      id: 7,
      name: 'kun',
      role: 1,
      status: 0,
      blocked_tag_ids: [1, 2]
    }
    findUniqueMock.mockResolvedValue(dbUser)

    const result = await verifyKunTokenWithUser(token)

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(setCachedAuthUserMock).toHaveBeenCalledWith(7, dbUser, {
      generation: '0',
      version: '0'
    })
    expect(result?.user).toEqual(dbUser)
  })

  it('token 已被 deleteKunToken 删除时, 即便旧缓存仍在也拒绝且不读缓存 (闸门 A 不变量)', async () => {
    // 模拟 deleteKunToken 已 delKvs 掉 access token: redis 中该 token 键为空
    getKvsMock.mockResolvedValue([null, null])
    // 旧鉴权缓存尚未随 version 轮转失效, 仍是一条 role=4 超管记录
    getCachedAuthUserMock.mockResolvedValue({
      id: 7,
      name: 'kun',
      role: 4,
      status: 0,
      blocked_tag_ids: []
    })

    const result = await verifyKunTokenWithUser(token)

    expect(result).toBeNull()
    // 凭证已删 → 在读缓存之前即短路, 陈旧缓存永不被采信
    expect(getCachedAuthUserMock).not.toHaveBeenCalled()
    expect(findUniqueMock).not.toHaveBeenCalled()
  })
})
