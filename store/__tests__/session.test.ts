import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCookieJar } from './cookieJar'
import type { UserState } from '~/types/api/session'
import type { UnreadSnapshot } from '~/types/api/message'

const { kunFetchGetMock } = vi.hoisted(() => ({ kunFetchGetMock: vi.fn() }))

vi.mock('~/utils/kunFetch', () => ({ kunFetchGet: kunFetchGetMock }))

const user = (uid: number, patch: Partial<UserState> = {}): UserState => ({
  uid,
  name: `user-${uid}`,
  avatar: '',
  bio: '',
  moemoepoint: 100,
  role: 1,
  dailyCheckIn: 0,
  dailyImageLimit: 0,
  dailyUploadLimit: 0,
  enableEmailNotice: false,
  allowPrivateMessage: true,
  blockedTagIds: [],
  enableRedirect: true,
  excludedDomains: [],
  delaySeconds: 5,
  ...patch
})
const A = user(7)
const B = user(8)

const snapshot = (
  asOf: number,
  hasUnreadNotification: boolean,
  hasUnreadConversation = false
): UnreadSnapshot => ({ hasUnreadNotification, hasUnreadConversation, asOf })

// 每个用例都是一次新的文档加载: 重新导入三个 store, 不用 setState 摆初始状态 (它自己会写存储)
const load = async (stored?: UserState) => {
  const items = new Map<string, string>()
  if (stored) {
    items.set(
      'kun-patch-user-store',
      JSON.stringify({ state: { user: stored }, version: 0 })
    )
  }
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key)
    }
  })
  const jar = createCookieJar({
    'kun-patch-setting-store|state|data|kunNsfwEnable': 'all',
    'kun-patch-setting-store|version': '0'
  })
  const session = await import('~/store/session')
  const { kunUserStore } = await import('~/store/userStore')
  const { kunUnreadStore } = await import('~/store/messageStore')
  const { useSettingStore } = await import('~/store/settingStore')
  await useSettingStore.persist.rehydrate()
  return {
    ...session,
    items,
    jar,
    identity: () => kunUserStore.getState(),
    unread: () => kunUnreadStore.getState(),
    nsfw: () => useSettingStore.getState().data.kunNsfwEnable
  }
}

beforeEach(() => {
  vi.resetModules()
  kunFetchGetMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('身份三态', () => {
  // P25-01: 就绪曾拿冻结的首屏 initialSession 与 store 比 uid, 站内登出或换号后顶栏一直是骨架
  it('首屏 A → 站内登出 → 以 B 登录: 每一步都是确定的身份, 最后是 B', async () => {
    const s = await load()
    kunFetchGetMock.mockResolvedValue(snapshot(300, false, true))

    expect(s.identity().status).toBe('pending')
    s.reconcileKunSession({ user: A, unread: snapshot(100, true) })
    expect(s.identity()).toEqual({ status: 'authenticated', user: A })

    s.endKunClientSession()
    expect(s.identity().status).toBe('guest')
    expect(s.identity().user.uid).toBe(0)

    s.signInKunSession(B)
    expect(s.identity()).toEqual({ status: 'authenticated', user: B })
    // 上一账号的未读先清掉, 不等补取的结果
    expect(s.unread()).toMatchObject({
      hasUnreadNotification: false,
      hasUnreadConversation: false
    })
    expect(kunFetchGetMock).toHaveBeenCalledWith('/message/unread')
    await vi.waitFor(() =>
      expect(s.unread()).toEqual(snapshot(300, false, true))
    )
  })

  it('登入后补取未读失败: 未读保持清空', async () => {
    const s = await load()
    kunFetchGetMock.mockResolvedValue('网络连接失败, 请检查网络后重试')
    s.reconcileKunSession({ user: A, unread: snapshot(100, true) })

    s.signInKunSession(B)
    await Promise.resolve()
    await Promise.resolve()

    expect(s.unread()).toEqual(snapshot(0, false))
  })

  it('离开 pending 之后任何命令都不会回到 pending', async () => {
    const s = await load()
    kunFetchGetMock.mockResolvedValue('x')
    const steps = [
      () => s.markKunSessionGuest(),
      () => s.reconcileKunSession({ user: A, unread: snapshot(1, false) }),
      () => s.keepKunStoredSession(),
      () => s.markKunSessionGuest(),
      () => s.patchKunUser({ bio: 'b' }),
      () => s.endKunClientSession(),
      () => s.keepKunStoredSession(),
      () => s.signInKunSession(B),
      () => s.applyUnreadSnapshot(snapshot(5, true)),
      () => s.markNotificationsSeen(),
      // 读回存储也不行, 哪怕存储里写着 status: 'pending'
      () => {
        s.items.set(
          'kun-patch-user-store',
          JSON.stringify({ state: { user: A, status: 'pending' }, version: 0 })
        )
        return s.loadKunStoredUid()
      }
    ]
    for (const step of steps) {
      await step()
      expect(s.identity().status).not.toBe('pending')
    }
  })

  it('没有会话、本地也没有记着用户: pending → guest; 已判定过的不受影响', async () => {
    const s = await load()
    s.markKunSessionGuest()
    expect(s.identity().status).toBe('guest')

    s.reconcileKunSession({ user: A, unread: snapshot(1, false) })
    s.markKunSessionGuest()
    expect(s.identity()).toEqual({ status: 'authenticated', user: A })
  })

  it('回查不可达: 沿用 store 里记着的用户; 没记着就是游客', async () => {
    const withUser = await load(A)
    expect(await withUser.loadKunStoredUid()).toBe(A.uid)
    expect(withUser.identity()).toEqual({ status: 'pending', user: A })
    withUser.keepKunStoredSession()
    expect(withUser.identity()).toEqual({ status: 'authenticated', user: A })

    vi.resetModules()
    const withoutUser = await load()
    expect(await withoutUser.loadKunStoredUid()).toBe(0)
    withoutUser.keepKunStoredSession()
    expect(withoutUser.identity().status).toBe('guest')
  })

  // 判定过之后 router.refresh 带回的会话变成没有, 缺会话回查会再走一遍。这时存储可能已被
  // 别的标签页改写: 那边登出写进了访客, 读回来就成了「已登录的访客」(铃铛加空头像)
  it('判定过之后不再读存储, 以内存里的用户为准', async () => {
    const s = await load()
    s.reconcileKunSession({ user: A, unread: snapshot(1, false) })
    s.items.set(
      'kun-patch-user-store',
      JSON.stringify({ state: { user: user(0, { name: '' }) }, version: 0 })
    )

    expect(await s.loadKunStoredUid()).toBe(A.uid)
    expect(s.identity()).toEqual({ status: 'authenticated', user: A })
  })

  // 浏览器禁用站点数据时 window.localStorage 的 getter 抛错, persist 不会被装上。
  // 曾经在这里抛出未处理的拒绝, 顶栏永远停在骨架
  it('存储不可用: 读回不抛错, 按没有记着用户处理', async () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('blocked')
      }
    })
    createCookieJar()
    const session = await import('~/store/session')
    const { kunUserStore } = await import('~/store/userStore')

    expect(await session.loadKunStoredUid()).toBe(0)
    session.markKunSessionGuest()
    expect(kunUserStore.getState().status).toBe('guest')
  })
})

describe('登入、登出与换号的代次', () => {
  it('只有登入、登出与换号推进代次', async () => {
    const s = await load()
    kunFetchGetMock.mockResolvedValue('x')
    const epochs = [s.getKunSessionEpoch()]
    const step = (run: () => void) => {
      run()
      epochs.push(s.getKunSessionEpoch())
    }
    step(() => s.reconcileKunSession({ user: A, unread: snapshot(1, false) }))
    step(() => s.reconcileKunSession({ user: A, unread: snapshot(2, false) }))
    step(() => s.patchKunUser({ bio: 'b' }))
    step(() => s.applyUnreadSnapshot(snapshot(3, true)))
    step(() => s.reconcileKunSession({ user: B, unread: snapshot(4, false) }))
    step(() => s.endKunClientSession())
    step(() => s.signInKunSession(A))

    const [e0] = epochs
    expect(epochs).toEqual([e0, e0, e0, e0, e0, e0 + 1, e0 + 2, e0 + 3])
  })

  // 登入后补取的未读晚到: 期间登出又换了号, 上一账号的快照不能落到新账号上,
  // 还会因为时刻更新挡掉新账号从缓存拿到的快照
  it('登入后补取的未读只落到发起它的那次登入上', async () => {
    const s = await load()
    const pending: ((value: UnreadSnapshot) => void)[] = []
    kunFetchGetMock.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve))
    )

    s.signInKunSession(B)
    s.endKunClientSession()
    s.signInKunSession(user(9))
    const [forB, forC] = pending
    forB(snapshot(200, true, true))
    forC(snapshot(150, false, false))
    await vi.waitFor(() => expect(s.unread()).toEqual(snapshot(150, false)))
  })
})

describe('同一文档里再次收到服务端会话', () => {
  it('同一账号: 以服务端快照覆盖 user (刷新自愈)', async () => {
    const s = await load()
    s.reconcileKunSession({ user: A, unread: snapshot(100, false) })
    s.patchKunUser({ bio: '只在客户端改过' })

    s.reconcileKunSession({
      user: { ...A, bio: '服务端的值' },
      unread: snapshot(200, true)
    })

    expect(s.identity().user.bio).toBe('服务端的值')
    expect(s.unread()).toEqual(snapshot(200, true))
  })

  // 新账号的快照不能因为比上一账号的旧而被丢掉
  it('换了账号: 先清掉上一账号的未读, 再落新账号的快照', async () => {
    const s = await load()
    s.reconcileKunSession({ user: A, unread: snapshot(300, true, true) })

    s.reconcileKunSession({ user: B, unread: snapshot(100, false) })

    expect(s.identity()).toEqual({ status: 'authenticated', user: B })
    expect(s.unread()).toEqual(snapshot(100, false))
  })

  it('pending 时不清未读: 已读接口先落地的快照比首屏快照新', async () => {
    const s = await load()
    s.applyUnreadSnapshot(snapshot(200, false))

    s.reconcileKunSession({ user: A, unread: snapshot(100, true) })

    expect(s.unread()).toEqual(snapshot(200, false))
  })
})

describe('patchKunUser 基于当前状态合并', () => {
  // P31-01: 两个保存请求在途重叠时, 后完成者用点击那一帧的 user 快照整对象回写,
  // 把先完成者的字段与萌萌点改回旧值
  it('两次交错的改动互不覆盖, 萌萌点按增量累加', async () => {
    const s = await load()
    s.reconcileKunSession({ user: A, unread: snapshot(1, false) })

    // 改名 (-30) 与签到 (+5) 的应答按任意顺序落地
    s.patchKunUser({ dailyCheckIn: 1, moemoepointDelta: 5 })
    s.patchKunUser({ name: 'renamed', moemoepointDelta: -30 })
    s.patchKunUser({ bio: 'bio' })

    expect(s.identity().user).toEqual({
      ...A,
      name: 'renamed',
      bio: 'bio',
      dailyCheckIn: 1,
      moemoepoint: 75
    })
  })

  it('不带增量时萌萌点不变', async () => {
    const s = await load()
    s.reconcileKunSession({ user: A, unread: snapshot(1, false) })

    s.patchKunUser({ avatar: 'a.webp' })

    expect(s.identity().user.moemoepoint).toBe(100)
  })

  it('判定之前与登出之后的改动不落地', async () => {
    const s = await load()
    s.patchKunUser({ name: 'early' })
    expect(s.identity()).toMatchObject({ status: 'pending', user: { uid: 0 } })
    expect(s.identity().user.name).toBe('')

    s.reconcileKunSession({ user: A, unread: snapshot(1, false) })
    s.endKunClientSession()
    s.patchKunUser({ name: 'late', moemoepointDelta: 5 })

    expect(s.identity().user).toMatchObject({
      uid: 0,
      name: '',
      moemoepoint: 0
    })
  })
})

describe('endKunClientSession', () => {
  // P31-02: 改密那份登出只清了 user, 上一账号的分级偏好与未读带进下一次登录
  it('一次复位 user、未读与分级设置', async () => {
    const s = await load()
    s.reconcileKunSession({ user: A, unread: snapshot(100, true, true) })
    expect(s.nsfw()).toBe('all')

    s.endKunClientSession()

    expect(s.identity()).toMatchObject({ status: 'guest', user: { uid: 0 } })
    expect(s.unread()).toEqual(snapshot(0, false))
    expect(s.nsfw()).toBe('sfw')
  })

  it('整页加载那一次会话写入不写设置 cookie, 只有登出时重置', async () => {
    const s = await load()
    s.reconcileKunSession({ user: A, unread: snapshot(1, false) })
    s.patchKunUser({ blockedTagIds: [1] })
    expect(s.jar.writes).toBe(0)

    s.endKunClientSession()
    expect(s.jar.writes).toBeGreaterThan(0)
  })
})

describe('未读快照按服务端时刻排序', () => {
  // X13-02: 首屏快照排在懒块之后才写入, 冷缓存打开消息页时盖掉已读接口刚写入的新值
  it('比当前旧的快照被丢弃, 不早于当前的落地', async () => {
    const s = await load()
    s.applyUnreadSnapshot(snapshot(200, false))

    s.applyUnreadSnapshot(snapshot(100, true, true))
    expect(s.unread()).toEqual(snapshot(200, false))

    s.applyUnreadSnapshot(snapshot(200, true))
    expect(s.unread()).toEqual(snapshot(200, true))

    s.applyUnreadSnapshot(snapshot(300, false, true))
    expect(s.unread()).toEqual(snapshot(300, false, true))
  })

  it('只取快照的三个字段', async () => {
    const s = await load()
    s.applyUnreadSnapshot({
      ...snapshot(5, true),
      extra: 1
    } as UnreadSnapshot)

    expect(s.unread()).toEqual(snapshot(5, true))
  })

  it('铃铛的乐观清除不改时刻, 之后更旧的快照仍被丢弃', async () => {
    const s = await load()
    s.applyUnreadSnapshot(snapshot(100, true, true))

    s.markNotificationsSeen()
    expect(s.unread()).toEqual(snapshot(100, false, true))

    s.applyUnreadSnapshot(snapshot(90, true, true))
    expect(s.unread()).toEqual(snapshot(100, false, true))

    s.applyUnreadSnapshot(snapshot(150, true, false))
    expect(s.unread()).toEqual(snapshot(150, true, false))
  })
})
