import { MESSAGE_TYPE } from '~/constants/message'

export interface Message {
  id: number
  type: string
  content: string
  status: number
  link: string
  created: string | Date
  sender: KunUser | null
}

export interface CreateMessageType {
  type: (typeof MESSAGE_TYPE)[number]
  content: string
  link: string
  sender_id?: number
  recipient_id?: number
}

export interface MessageUnreadStatus {
  hasUnreadNotification: boolean
  hasUnreadConversation: boolean
}

// 服务端算出的未读快照。asOf 是算这份快照的查询开始的时刻 (服务端毫秒时间戳), 客户端只让
// 不早于当前值的快照落地 (store/session.ts 的 applyUnreadSnapshot)。缓存里没有它的旧条目按 0 算
export interface UnreadSnapshot extends MessageUnreadStatus {
  asOf: number
}
