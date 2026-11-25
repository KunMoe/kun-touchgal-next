import { createStore, useStore } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { UserState } from '~/types/api/session'

// 这个文档里有没有判定过访客身份。pending 是首帧与等待会话回查的状态, 判定之后只在
// guest 与 authenticated 之间切换, 不再回到 pending
export type KunSessionStatus = 'pending' | 'guest' | 'authenticated'

export interface UserStoreState {
  status: KunSessionStatus
  user: UserState
}

export const KUN_GUEST_USER: UserState = {
  uid: 0,
  name: '',
  avatar: '',
  bio: '',
  moemoepoint: 0,
  role: 1,
  dailyCheckIn: 1,
  dailyImageLimit: 0,
  dailyUploadLimit: 0,
  enableEmailNotice: false,
  allowPrivateMessage: true,
  blockedTagIds: [],

  enableRedirect: true,
  excludedDomains: [],
  delaySeconds: 5
}

// 只许 store/session.ts 导入 (kun/inv-session-01): 写入一律经那里的命令, 组件拿不到 setState
export const kunUserStore = createStore<UserStoreState>()(
  persist((): UserStoreState => ({ status: 'pending', user: KUN_GUEST_USER }), {
    name: 'kun-patch-user-store',
    storage: createJSONStorage(() => window.localStorage),
    skipHydration: true,
    // 存储形状仍是 { state: { user }, version: 0 }。status 不持久化: 从 localStorage 读回来的
    // 旧用户不算这个文档判定过的身份
    partialize: (state) => ({ user: state.user })
  })
)

export const useUserStore = <T>(selector: (state: UserStoreState) => T): T =>
  useStore(kunUserStore, selector)

// 事件处理器里读当前值用 (不订阅)
export const getKunUserSnapshot = () => kunUserStore.getState().user

export const rehydrateKunUserStore = () => kunUserStore.persist.rehydrate()
