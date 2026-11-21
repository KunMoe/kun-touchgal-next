import { ChatContainer } from '~/components/message/chat/ChatContainer'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import { KunBreadcrumbTitle } from '~/components/kun/BreadcrumbTitle'
import { kunGetConversationMessagesAction } from '../actions'
import { kunMetadata } from '../metadata'
import type { Metadata } from 'next'

export const revalidate = 0

export const metadata: Metadata = kunMetadata

interface Props {
  params: Promise<{ conversationId: string }>
}

export default async function Kun({ params }: Props) {
  const { conversationId } = await params
  const id = parseInt(conversationId, 10)

  if (isNaN(id)) {
    return <ErrorComponent error="无效的会话 ID" />
  }

  const response = await kunGetConversationMessagesAction(id, {
    page: 1,
    limit: 30
  })

  if (typeof response === 'string') {
    return <ErrorComponent error={response} />
  }

  return (
    <>
      <KunBreadcrumbTitle
        routeKey={`/message/chat/${id}`}
        title={`与${response.otherUser.name}的私聊`}
      />
      <ChatContainer
        conversationId={id}
        initialMessages={response.messages}
        total={response.total}
        otherUser={response.otherUser}
      />
    </>
  )
}
