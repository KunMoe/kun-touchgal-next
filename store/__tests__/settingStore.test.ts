import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCookieJar } from './cookieJar'

const NAME = 'kun-patch-setting-store'
const NSFW = `${NAME}|state|data|kunNsfwEnable`
const VERSION = `${NAME}|version`
// 旧版本的客户端会把屏蔽标签写成这个 cookie; 服务端已不读, 客户端也不再写
const LEGACY_MIRROR = `${NAME}|state|data|kunBlockedTagIds`

const LEGACY_JAR = {
  [NSFW]: 'nsfw',
  [LEGACY_MIRROR]: '[10001%2C10002]',
  [VERSION]: '0'
}

// 每个用例一份新的模块实例: 相当于一次新的文档加载
const loadStore = async () =>
  (await import('~/store/settingStore')).useSettingStore

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('settingStore 的持久化', () => {
  it('带着旧版本留下的屏蔽副本水合: 不写 cookie, 分级设置照常读回', async () => {
    const jar = createCookieJar(LEGACY_JAR)
    const useSettingStore = await loadStore()

    await useSettingStore.persist.rehydrate()

    expect(jar.writes).toBe(0)
    expect(jar.snapshot()).toEqual(LEGACY_JAR)
    expect(useSettingStore.getState().data.kunNsfwEnable).toBe('nsfw')
  })

  // NSFWSwitcher 的写法: 把读到的 data 展开再改分级。水合是浅合并, 旧字段还在内存里,
  // 靠 partialize 才不会被写回去
  it('下一次切换分级时旧副本被清掉, 只剩分级设置', async () => {
    const jar = createCookieJar(LEGACY_JAR)
    const useSettingStore = await loadStore()
    await useSettingStore.persist.rehydrate()

    const { data, setData } = useSettingStore.getState()
    setData({ ...data, kunNsfwEnable: 'all' })

    expect(jar.snapshot()).toEqual({ [NSFW]: 'all', [VERSION]: '0' })
  })

  it('重置同样清掉旧副本并回到 sfw', async () => {
    const jar = createCookieJar(LEGACY_JAR)
    const useSettingStore = await loadStore()
    await useSettingStore.persist.rehydrate()

    useSettingStore.getState().resetData()

    expect(jar.snapshot()).toEqual({ [NSFW]: 'sfw', [VERSION]: '0' })
    expect(useSettingStore.getState().data).toEqual({ kunNsfwEnable: 'sfw' })
  })

  it('没有任何 cookie 时水合不写入, 分级设置是默认的 sfw', async () => {
    const jar = createCookieJar()
    const useSettingStore = await loadStore()

    await useSettingStore.persist.rehydrate()

    expect(jar.writes).toBe(0)
    expect(useSettingStore.getState().data).toEqual({ kunNsfwEnable: 'sfw' })
  })
})
