import { createStore, useStore } from 'zustand'
import type { UnreadSnapshot } from '~/types/api/message'

export const KUN_NO_UNREAD: UnreadSnapshot = {
  hasUnreadNotification: false,
  hasUnreadConversation: false,
  asOf: 0
}

// 只许 store/session.ts 导入 (kun/inv-session-01): 未读只接受服务端打了时刻的快照
export const kunUnreadStore = createStore<UnreadSnapshot>()(() => KUN_NO_UNREAD)

export const useMessageStore = <T>(selector: (state: UnreadSnapshot) => T): T =>
  useStore(kunUnreadStore, selector)
