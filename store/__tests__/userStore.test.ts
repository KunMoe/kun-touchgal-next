import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCookieJar } from './cookieJar'

const NAME = 'kun-patch-setting-store'
const JAR = {
  [`${NAME}|state|data|kunNsfwEnable`]: 'all',
  [`${NAME}|state|data|kunBlockedTagIds`]: '[10001%2C10002]',
  [`${NAME}|version`]: '0'
}

const USER = {
  uid: 7,
  name: 'kun',
  avatar: '',
  bio: '',
  moemoepoint: 0,
  role: 1,
  dailyCheckIn: 1,
  dailyImageLimit: 0,
  dailyUploadLimit: 0,
  enableEmailNotice: false,
  allowPrivateMessage: true,
  blockedTagIds: [1, 2, 3],
  enableRedirect: true,
  excludedDomains: [],
  delaySeconds: 5
}
const UNREAD = {
  hasUnreadNotification: false,
  hasUnreadConversation: false,
  asOf: 1
}

let items: Map<string, string>

beforeEach(() => {
  vi.resetModules()
  items = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key)
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// 顶栏在登录用户每次整页加载时都会把服务端会话写进 userStore。它曾顺带把屏蔽列表同步进
// 设置 store, 于是每次加载都删掉并重写全部设置 cookie
describe('userStore 不碰设置 cookie', () => {
  it('水合设置之后整页加载的会话写入: 一次 cookie 都不写', async () => {
    const jar = createCookieJar(JAR)
    const { useSettingStore } = await import('~/store/settingStore')
    const { reconcileKunSession } = await import('~/store/session')
    const { getKunUserSnapshot } = await import('~/store/userStore')
    await useSettingStore.persist.rehydrate()

    reconcileKunSession({ user: USER, unread: UNREAD })
    expect(getKunUserSnapshot()).toEqual(USER)
    expect(jar.writes).toBe(0)
    expect(jar.snapshot()).toEqual(JAR)
  })

  it('屏蔽列表变了也只留在 userStore 里', async () => {
    const jar = createCookieJar(JAR)
    const { useSettingStore } = await import('~/store/settingStore')
    const { patchKunUser, reconcileKunSession } =
      await import('~/store/session')
    const { getKunUserSnapshot } = await import('~/store/userStore')
    await useSettingStore.persist.rehydrate()

    reconcileKunSession({ user: USER, unread: UNREAD })
    patchKunUser({ blockedTagIds: [9] })

    expect(getKunUserSnapshot().blockedTagIds).toEqual([9])
    expect(jar.writes).toBe(0)
    expect(useSettingStore.getState().data.kunNsfwEnable).toBe('all')
  })
})

describe('userStore 的持久化', () => {
  it('存储形状仍是 { state: { user }, version: 0 }, 不带 status', async () => {
    createCookieJar()
    const { reconcileKunSession } = await import('~/store/session')

    reconcileKunSession({ user: USER, unread: UNREAD })

    expect(JSON.parse(items.get('kun-patch-user-store')!)).toEqual({
      state: { user: USER },
      version: 0
    })
  })

  // /doc 这类静态页没有首屏会话, 顶栏先从 localStorage 读回上次的用户再回查
  it('从存储读回来的用户不算判定过的身份', async () => {
    createCookieJar()
    items.set(
      'kun-patch-user-store',
      JSON.stringify({ state: { user: USER }, version: 0 })
    )
    const { kunUserStore } = await import('~/store/userStore')
    const { loadKunStoredUid } = await import('~/store/session')

    expect(await loadKunStoredUid()).toBe(USER.uid)

    expect(kunUserStore.getState()).toEqual({ status: 'pending', user: USER })
  })

  // 默认的浅合并会让存储里的任何键盖掉内存; 旧版本或改坏的 partialize 留下的 status
  // 会让没回查过的旧用户直接算作已登录
  it('读回时只取 user, 存储里多出来的 status 不生效', async () => {
    createCookieJar()
    items.set(
      'kun-patch-user-store',
      JSON.stringify({
        state: { user: USER, status: 'authenticated' },
        version: 0
      })
    )
    const { kunUserStore } = await import('~/store/userStore')
    const { loadKunStoredUid } = await import('~/store/session')

    await loadKunStoredUid()

    expect(kunUserStore.getState()).toEqual({ status: 'pending', user: USER })
  })
})
