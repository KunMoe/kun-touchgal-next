'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Button } from '@heroui/react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { KunNull } from '~/components/kun/Null'
import { ChatMessage } from './ChatMessage'
import { ChatInput } from './ChatInput'
import { DeleteConversationButton } from './DeleteConversationButton'
import { KunAvatar } from '~/components/kun/floating-card/KunAvatar'
import { kunFetchGet, kunFetchPut } from '~/utils/kunFetch'
import { kunDocumentTitle } from '~/utils/pageMetadata'
import { useUserStore } from '~/store/userStore'
import { applyUnreadSnapshot } from '~/store/session'
import { useKunInfiniteList } from '~/hooks/useKunInfiniteList'
import toast from 'react-hot-toast'
import type {
  MessageUpdateData,
  PrivateMessage
} from '~/types/api/conversation'
import type { UnreadSnapshot } from '~/types/api/message'

interface Props {
  conversationId: number
  initialMessages: PrivateMessage[]
  total: number
  otherUser: KunUser
}

interface HistoryQuery {
  page: number
  limit: number
  conversationId: number
}

const sortMessagesByTime = (msgs: PrivateMessage[]) => {
  return [...msgs].sort(
    (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime()
  )
}

const fetchHistoryPage = async (query: HistoryQuery) => {
  const response = await kunFetchGet<
    KunResponse<{
      messages: PrivateMessage[]
      total: number
      otherUser: KunUser
    }>
  >(`/message/conversation/${query.conversationId}`, {
    page: query.page,
    limit: query.limit
  })
  return typeof response === 'string'
    ? response
    : { items: response.messages, total: response.total }
}

export const ChatContainer = ({
  conversationId,
  initialMessages,
  total,
  otherUser
}: Props) => {
  // 失败即停 (#23): 未登录 / 无效 ID / 无权访问都是持久状态, 不再自动加载, 由用户刷新恢复
  const list = useKunInfiniteList<PrivateMessage, HistoryQuery>({
    query: { page: 1, limit: 30, conversationId },
    initial: { items: initialMessages, total },
    getId: (msg) => msg.id,
    grow: 'prepend',
    fetchPage: fetchHistoryPage,
    onFailure: (message) => toast.error(message)
  })
  const { insertLocal, patchLocal } = list
  const messages = useMemo(() => sortMessagesByTime(list.items), [list.items])
  const loading = list.status === 'loading'
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const user = useUserStore((state) => state.user)
  const isInitialMount = useRef(true)
  // 加载更早的一页时记下滚动高度, 那一页落地后按增量把视口留在原来那条消息上
  const scrollAnchorRef = useRef<number | null>(null)

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [])

  useLayoutEffect(() => {
    if (loading) {
      scrollAnchorRef.current = scrollContainerRef.current?.scrollHeight ?? null
    }
  }, [loading])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const previousScrollHeight = scrollAnchorRef.current
    scrollAnchorRef.current = null
    if (container && previousScrollHeight !== null) {
      container.scrollTop = container.scrollHeight - previousScrollHeight
    }
  }, [list.loadedPage])

  const handleMessageSent = useCallback(
    (newMessage: { id: number; content: string; created: string }) => {
      const message: PrivateMessage = {
        id: newMessage.id,
        content: newMessage.content,
        status: 0,
        isDeleted: false,
        editedAt: null,
        created: newMessage.created,
        sender: {
          id: user.uid,
          name: user.name,
          avatar: user.avatar
        }
      }
      insertLocal(message, 'end')
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    },
    [user, scrollToBottom, insertLocal]
  )

  const handleMessageUpdated = useCallback(
    (messageId: number, data: MessageUpdateData) => {
      if (data.action === 'delete') {
        patchLocal(messageId, { isDeleted: true })
      } else {
        patchLocal(messageId, {
          content: data.content,
          editedAt: data.editedAt
        })
      }
    },
    [patchLocal]
  )

  useEffect(() => {
    document.title = kunDocumentTitle(`与${otherUser.name}的私聊`)
  }, [otherUser.name])

  useEffect(() => {
    const markAsRead = async () => {
      const response = await kunFetchPut<KunResponse<UnreadSnapshot>>(
        `/message/conversation/${conversationId}/read`
      )
      if (typeof response !== 'string') {
        applyUnreadSnapshot(response)
      }
    }
    markAsRead()
  }, [conversationId])

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      scrollToBottom()
    }
  }, [scrollToBottom])

  return (
    <Card className="h-[calc(100vh-200px)] min-h-[500px]">
      <CardHeader className="border-b border-default-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            as={Link}
            href="/message/chat"
            variant="light"
            isIconOnly
            size="sm"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <KunAvatar
            uid={otherUser.id}
            avatarProps={{
              src: otherUser.avatar,
              name: otherUser.name,
              size: 'sm'
            }}
          />
          <span className="font-semibold">{otherUser.name}</span>
        </div>

        <DeleteConversationButton
          conversationId={conversationId}
          otherUserName={otherUser.name}
        />
      </CardHeader>

      <CardBody className="flex flex-col p-0">
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4">
          {list.hasMore && (
            <div ref={list.sentinelRef} className="flex justify-center py-2">
              {loading && (
                <Loader2 className="size-5 animate-spin text-default-400" />
              )}
            </div>
          )}

          {messages.length === 0 ? (
            <KunNull message="暂无消息，发送第一条消息吧" />
          ) : (
            <>
              {messages.map((msg) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  isOwn={msg.sender.id === user.uid}
                  conversationId={conversationId}
                  onMessageUpdated={handleMessageUpdated}
                />
              ))}
            </>
          )}
        </div>

        <div className="border-t border-default-200 p-4">
          <ChatInput
            conversationId={conversationId}
            onMessageSent={handleMessageSent}
          />
        </div>
      </CardBody>
    </Card>
  )
}
