'use client'

import { useEffect } from 'react'
import { KunLoading } from '~/components/kun/Loading'
import { KunListError } from '~/components/kun/ListError'
import { KunNull } from '~/components/kun/Null'
import { KunPagination } from '~/components/kun/Pagination'
import { ConversationCard } from './ConversationCard'
import { kunFetchGet } from '~/utils/kunFetch'
import { useMessageStore } from '~/store/messageStore'
import { useKunPagedList } from '~/hooks/useKunPagedList'
import type { KunListQuery } from '~/utils/list/kunListMachine'
import type { Conversation } from '~/types/api/conversation'

interface Props {
  initialConversations: Conversation[]
  total: number
}

const fetchConversationPage = async (query: KunListQuery) => {
  const response = await kunFetchGet<
    KunResponse<{
      conversations: Conversation[]
      total: number
    }>
  >('/message/conversation', {
    page: query.page,
    limit: query.limit
  })
  return typeof response === 'string'
    ? response
    : { items: response.conversations, total: response.total }
}

export const ConversationList = ({ initialConversations, total }: Props) => {
  const list = useKunPagedList<Conversation, KunListQuery>({
    query: { page: 1, limit: 30 },
    initial: { items: initialConversations, total },
    getId: (conv) => conv.id,
    fetchPage: fetchConversationPage
  })
  const loading = list.status === 'loading'
  const setHasUnreadConversation = useMessageStore(
    (state) => state.setHasUnreadConversation
  )

  const syncConversationUnreadStatus = (items: Conversation[]) => {
    setHasUnreadConversation(items.some((conv) => conv.unreadCount > 0))
  }

  // 每次取数落地后按落地的这一页重算未读, 失败不算落地。挂载时 items 就是 SSR 首屏,
  // 与下面按 initialConversations 的同步重复一次, 结果相同
  useEffect(() => {
    if (list.status === 'ready') {
      syncConversationUnreadStatus(list.items)
    }
  }, [list.items, list.status])

  useEffect(() => {
    syncConversationUnreadStatus(initialConversations)
  }, [initialConversations])

  return (
    <div className="space-y-4">
      {loading ? (
        <KunLoading hint="正在获取会话列表..." />
      ) : list.status === 'error' ? (
        <KunListError
          message={list.error ?? ''}
          onRetry={() => list.refresh()}
        />
      ) : list.items.length === 0 ? (
        <KunNull message="暂无私聊会话，您可以在其他用户的主页发起私聊" />
      ) : (
        <div className="space-y-3">
          {list.items.map((conv) => (
            <ConversationCard key={conv.id} conversation={conv} />
          ))}
        </div>
      )}

      {list.total > 30 && (
        <div className="flex justify-center">
          <KunPagination
            total={Math.ceil(list.total / 30)}
            page={list.query.page}
            onPageChange={list.setPage}
            isLoading={loading}
          />
        </div>
      )}
    </div>
  )
}
