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

beforeEach(() => {
  vi.resetModules()
  const items = new Map<string, string>()
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

// 顶栏在登录用户每次整页加载时都会 setUser。它曾顺带把屏蔽列表同步进设置 store,
// 于是每次加载都删掉并重写全部设置 cookie
describe('userStore 不碰设置 cookie', () => {
  it('水合设置之后 setUser、再 logout: 一次 cookie 都不写', async () => {
    const jar = createCookieJar(JAR)
    const { useSettingStore } = await import('~/store/settingStore')
    const { useUserStore } = await import('~/store/userStore')
    await useSettingStore.persist.rehydrate()

    useUserStore.getState().setUser(USER)
    expect(useUserStore.getState().user).toEqual(USER)
    expect(jar.writes).toBe(0)

    useUserStore.getState().logout()
    expect(useUserStore.getState().user.uid).toBe(0)
    expect(jar.writes).toBe(0)
    expect(jar.snapshot()).toEqual(JAR)
  })

  it('屏蔽列表变了也只留在 userStore 里', async () => {
    const jar = createCookieJar(JAR)
    const { useSettingStore } = await import('~/store/settingStore')
    const { useUserStore } = await import('~/store/userStore')
    await useSettingStore.persist.rehydrate()

    useUserStore.getState().setUser(USER)
    useUserStore.getState().setUser({ ...USER, blockedTagIds: [9] })

    expect(useUserStore.getState().user.blockedTagIds).toEqual([9])
    expect(jar.writes).toBe(0)
    expect(useSettingStore.getState().data.kunNsfwEnable).toBe('all')
  })
})
