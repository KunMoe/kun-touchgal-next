import { beforeEach, describe, expect, it, vi } from 'vitest'

const { kvStore, getKvMock, setKvMock } = vi.hoisted(() => {
  const kvStore = new Map<string, string>()
  return {
    kvStore,
    getKvMock: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    setKvMock: vi.fn(async (key: string, value: string) => {
      kvStore.set(key, value)
    })
  }
})

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock
}))

import {
  getCachedAuthUser,
  getUserSessionCacheScope,
  invalidateUserSession,
  setCachedAuthUser,
  type AuthUserCache
} from '~/app/api/user/session/cache'

const uid = 7
const authUser: AuthUserCache = {
  id: uid,
  name: 'kun',
  role: 1,
  status: 0,
  blocked_tag_ids: [10, 20]
}

beforeEach(() => {
  vi.clearAllMocks()
  kvStore.clear()
})

describe('auth-user 缓存', () => {
  it('写入后按同一 scope 可读回完整字段', async () => {
    const scope = await getUserSessionCacheScope(uid)
    await setCachedAuthUser(uid, authUser, scope)

    await expect(getCachedAuthUser(uid, scope)).resolves.toEqual(authUser)
  })

  it('invalidateUserSession 使旧 scope 缓存失效 (key 随 version 漂移)', async () => {
    const oldScope = await getUserSessionCacheScope(uid)
    await setCachedAuthUser(uid, authUser, oldScope)

    await invalidateUserSession(uid)
    const newScope = await getUserSessionCacheScope(uid)

    expect(newScope.version).not.toBe(oldScope.version)
    await expect(getCachedAuthUser(uid, newScope)).resolves.toBeNull()
  })

  it('scope 漂移后用旧 scope 写入在当前 scope 下不可见 (命名空间隔离)', async () => {
    const staleScope = await getUserSessionCacheScope(uid)
    await invalidateUserSession(uid)

    await setCachedAuthUser(uid, authUser, staleScope)

    const currentScope = await getUserSessionCacheScope(uid)
    await expect(getCachedAuthUser(uid, currentScope)).resolves.toBeNull()
  })
})
