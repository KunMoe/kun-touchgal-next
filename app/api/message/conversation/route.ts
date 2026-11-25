import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  getConversationsSchema,
  createConversationSchema
} from '~/validations/conversation'
import { getConversations, getOrCreateConversation } from './service'
import {
  getUnreadMessageStatus,
  KUN_UNREAD_UNAVAILABLE
} from '~/app/api/message/unread/service'

export const GET = kunRoute.get({
  auth: 'user',
  input: getConversationsSchema,
  // 未读顺带返回: 列表翻页 / 刷新时据此更新导航与顶栏的红点, 不从本页的 unreadCount 推导
  // (未读会话不在本页时那样会把全局红点清掉)。未读查不到不拖垮列表
  handler: async ({ input, actor: payload }) => {
    const [list, unread] = await Promise.all([
      getConversations(input, payload.uid),
      getUnreadMessageStatus(payload.uid).catch(() => KUN_UNREAD_UNAVAILABLE)
    ])
    return { ...list, unread }
  }
})

export const POST = kunRoute.post({
  auth: 'user',
  input: createConversationSchema,
  abuse: ['conversation.open'],
  handler: async ({ input, actor: payload }) =>
    getOrCreateConversation(input, payload)
})
