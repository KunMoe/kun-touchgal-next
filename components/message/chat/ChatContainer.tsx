'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Button } from '@heroui/react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { KunNull } from '~/components/kun/Null'
import { ChatMessage } from './ChatMessage'
import { ChatInput } from './ChatInput'
import { DeleteConversationButton } from './DeleteConversationButton'
import { dropLoadedMessages } from './dropLoadedMessages'
import { KunAvatar } from '~/components/kun/floating-card/KunAvatar'
import { kunFetchGet, kunFetchPut } from '~/utils/kunFetch'
import { kunDocumentTitle } from '~/utils/pageMetadata'
import { useUserStore } from '~/store/userStore'
import { useMessageStore } from '~/store/messageStore'
import toast from 'react-hot-toast'
import type {
  MessageUpdateData,
  PrivateMessage
} from '~/types/api/conversation'
import type { MessageUnreadStatus } from '~/types/api/message'

interface Props {
  conversationId: number
  initialMessages: PrivateMessage[]
  total: number
  otherUser: KunUser
}

const sortMessagesByTime = (msgs: PrivateMessage[]) => {
  return [...msgs].sort(
    (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime()
  )
}

export const ChatContainer = ({
  conversationId,
  initialMessages,
  total,
  otherUser
}: Props) => {
  const [messages, setMessages] = useState<PrivateMessage[]>(
    sortMessagesByTime(initialMessages)
  )
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(initialMessages.length < total)
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(total)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const user = useUserStore((state) => state.user)
  const setUnreadMessageStatus = useMessageStore(
    (state) => state.setUnreadMessageStatus
  )
  const isInitialMount = useRef(true)

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [])

  const loadMoreMessages = useCallback(async () => {
    if (loading || !hasMore) return

    setLoading(true)
    const nextPage = page + 1

    // 失败后必须关掉 hasMore: 哨兵可见时 loading 一复位, observer 就会重建并立刻再触发加载,
    // 抛错与路由返回的字符串错误(未登录 / 无效 ID / 无权访问)都是持久状态, 会变成紧循环, 由用户刷新恢复
    try {
      const response = await kunFetchGet<
        KunResponse<{
          messages: PrivateMessage[]
          total: number
          otherUser: KunUser
        }>
      >(`/message/conversation/${conversationId}`, {
        page: nextPage,
        limit: 30
      })

      if (typeof response === 'string') {
        toast.error(response)
        setHasMore(false)
      } else {
        const scrollContainer = scrollContainerRef.current
        const previousScrollHeight = scrollContainer?.scrollHeight || 0

        setMessages((prev) =>
          sortMessagesByTime([
            ...dropLoadedMessages(prev, response.messages),
            ...prev
          ])
        )
        setPage(nextPage)
        setTotalCount(response.total)
        setHasMore((page + 1) * 30 < response.total)

        requestAnimationFrame(() => {
          if (scrollContainer) {
            const newScrollHeight = scrollContainer.scrollHeight
            scrollContainer.scrollTop = newScrollHeight - previousScrollHeight
          }
        })
      }
    } catch {
      toast.error('获取历史消息失败, 请刷新页面重试')
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [loading, hasMore, page, conversationId])

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
      setMessages((prev) => sortMessagesByTime([...prev, message]))
      setTotalCount((prev) => prev + 1)
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    },
    [user, scrollToBottom]
  )

  const handleMessageUpdated = useCallback(
    (messageId: number, data: MessageUpdateData) => {
      if (data.action === 'delete') {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, isDeleted: true } : msg
          )
        )
      } else {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? { ...msg, content: data.content, editedAt: data.editedAt }
              : msg
          )
        )
      }
    },
    []
  )

  useEffect(() => {
    document.title = kunDocumentTitle(`与${otherUser.name}的私聊`)
  }, [otherUser.name])

  useEffect(() => {
    const markAsRead = async () => {
      const response = await kunFetchPut<KunResponse<MessageUnreadStatus>>(
        `/message/conversation/${conversationId}/read`
      )
      if (typeof response !== 'string') {
        setUnreadMessageStatus(response)
      }
    }
    markAsRead()
  }, [conversationId, setUnreadMessageStatus])

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      scrollToBottom()
    }
  }, [scrollToBottom])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMoreMessages()
        }
      },
      { threshold: 0.1 }
    )

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current)
    }

    return () => observer.disconnect()
  }, [hasMore, loading, loadMoreMessages])

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
          {hasMore && (
            <div ref={loadMoreRef} className="flex justify-center py-2">
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
