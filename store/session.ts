import { kunUserStore, KUN_GUEST_USER } from './userStore'
import { kunUnreadStore, KUN_NO_UNREAD } from './messageStore'
import { useSettingStore } from './settingStore'
import { kunFetchGet } from '~/utils/kunFetch'
import type { UserSession, UserState } from '~/types/api/session'
import type { UnreadSnapshot } from '~/types/api/message'

// 客户端会话镜像 (userStore 的身份与用户、messageStore 的未读) 的唯一写者。组件只读两个
// store, 状态迁移都在这里: 「登出要清哪些 store」「写回不得用点击那一帧的快照」「旧快照
// 不得盖掉新值」各只写一次, 在 node 下有行为测试 (store/__tests__/session.test.ts)

// 改动只收这次改了的字段: 合并发生在 set 里, 基于当前状态, 两个在途请求先后落地互不覆盖。
// uid / role 不由客户端改; 萌萌点只收增量 (增量可交换, 应答乱序也不丢)。三个 never 键让
// patchKunUser({ ...user, x }) 这类整份快照的展开编译不过, 其余展开由 kun/inv-session-02 拦
export type UserStatePatch = Partial<
  Omit<UserState, 'uid' | 'role' | 'moemoepoint'>
> & {
  uid?: never
  role?: never
  moemoepoint?: never
  moemoepointDelta?: number
}

// 未读按服务端算出快照的时刻排序, 只让不早于当前值的落地: 首屏快照排在懒块之后才写入、
// router.refresh 带回的旧值, 都盖不掉已读接口刚写入的新值。只比服务端时间戳, 与客户端时钟无关
export const applyUnreadSnapshot = (snapshot: UnreadSnapshot) => {
  if (snapshot.asOf < kunUnreadStore.getState().asOf) {
    return
  }
  kunUnreadStore.setState({
    hasUnreadNotification: snapshot.hasUnreadNotification,
    hasUnreadConversation: snapshot.hasUnreadConversation,
    asOf: snapshot.asOf
  })
}

// 铃铛的乐观清除: 不改时刻, 随后已读接口的快照照常落地
export const markNotificationsSeen = () => {
  kunUnreadStore.setState({ hasUnreadNotification: false })
}

const resetUnread = () => {
  kunUnreadStore.setState(KUN_NO_UNREAD)
}

// 服务端给出的会话: 首屏的 initialSession、同一文档里 router.refresh 带回的新快照、缺会话时
// 回查的结果。同一账号以服务端快照覆盖 user (refresh 晚于它发出之前完成的所有写入, 保留
// 刷新自愈); 换了账号先清掉上一账号的未读。pending 时不清: 那时已落地的未读快照来自已读接口,
// 比首屏快照新
export const reconcileKunSession = ({ user, unread }: UserSession) => {
  const current = kunUserStore.getState()
  if (current.status !== 'pending' && current.user.uid !== user.uid) {
    resetUnread()
  }
  kunUserStore.setState({ status: 'authenticated', user })
  applyUnreadSnapshot(unread)
}

// 没有会话, 本地也没记着用户
export const markKunSessionGuest = () => {
  if (kunUserStore.getState().status === 'pending') {
    kunUserStore.setState({ status: 'guest' })
  }
}

// 缺会话时回查不可达: 沿用这台设备上记下的用户, 等下一次整页加载再判定
export const keepKunStoredSession = () => {
  const { status, user } = kunUserStore.getState()
  if (status === 'pending') {
    kunUserStore.setState({ status: user.uid ? 'authenticated' : 'guest' })
  }
}

// 登录、2FA 第二步与注册共用。这三个接口不带未读, 登入后补取一次
export const signInKunSession = (user: UserState) => {
  resetUnread()
  kunUserStore.setState({ status: 'authenticated', user })
  void kunFetchGet<UnreadSnapshot>('/message/unread').then((res) => {
    if (typeof res !== 'string') {
      applyUnreadSnapshot(res)
    }
  })
}

// 所有登出路径的客户端清理 (导航与提示在 hooks/useKunSession.ts)。分级偏好随会话重置
export const endKunClientSession = () => {
  kunUserStore.setState({ status: 'guest', user: KUN_GUEST_USER })
  resetUnread()
  useSettingStore.getState().resetData()
}

// 只在已登录时生效: pending 窗口里的改动会被随后的首屏快照覆盖, 登出后的晚到应答不该写回
export const patchKunUser = ({
  moemoepointDelta = 0,
  ...fields
}: UserStatePatch) => {
  if (kunUserStore.getState().status !== 'authenticated') {
    return
  }
  kunUserStore.setState((state) => ({
    user: {
      ...state.user,
      ...fields,
      moemoepoint: state.user.moemoepoint + moemoepointDelta
    }
  }))
}
