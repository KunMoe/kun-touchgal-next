import { ConversationList } from '~/components/message/chat/ConversationList'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import { kunGetConversationsAction } from './actions'
import { getServerUserSession } from '~/app/api/user/session/service'
import { KUN_UNREAD_UNAVAILABLE } from '~/app/api/message/unread/service'
import { kunMetadata } from './metadata'
import type { Metadata } from 'next'

export const revalidate = 0

export const metadata: Metadata = kunMetadata

export default async function Kun() {
  // 未读取根布局同一次渲染里已经解析过的会话 (按令牌去重), 不再单独查一次
  const [response, session] = await Promise.all([
    kunGetConversationsAction({ page: 1, limit: 30 }),
    getServerUserSession()
  ])
  if (typeof response === 'string') {
    return <ErrorComponent error={response} />
  }

  return (
    <ConversationList
      initialConversations={response.conversations}
      total={response.total}
      initialUnread={session?.unread ?? KUN_UNREAD_UNAVAILABLE}
    />
  )
}
