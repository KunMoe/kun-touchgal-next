'use client'

import { useEffect } from 'react'
import { KunLoading } from '~/components/kun/Loading'
import { KunListError } from '~/components/kun/ListError'
import { KunNull } from '~/components/kun/Null'
import { KunPagination } from '~/components/kun/Pagination'
import { ConversationCard } from './ConversationCard'
import { kunFetchGet } from '~/utils/kunFetch'
import { applyUnreadSnapshot } from '~/store/session'
import { useKunPagedList } from '~/hooks/useKunPagedList'
import type { KunListQuery } from '~/utils/list/kunListMachine'
import type { Conversation } from '~/types/api/conversation'
import type { UnreadSnapshot } from '~/types/api/message'

interface Props {
  initialConversations: Conversation[]
  total: number
  initialUnread: UnreadSnapshot
}

const fetchConversationPage = async (query: KunListQuery) => {
  const response = await kunFetchGet<
    KunResponse<{
      conversations: Conversation[]
      total: number
      unread: UnreadSnapshot
    }>
  >('/message/conversation', {
    page: query.page,
    limit: query.limit
  })
  if (typeof response === 'string') {
    return response
  }
  // 未读是全局的, 与这一页落不落地无关; 先后由快照的时刻裁决
  applyUnreadSnapshot(response.unread)
  return { items: response.conversations, total: response.total }
}

export const ConversationList = ({
  initialConversations,
  total,
  initialUnread
}: Props) => {
  const list = useKunPagedList<Conversation, KunListQuery>({
    query: { page: 1, limit: 30 },
    initial: { items: initialConversations, total },
    getId: (conv) => conv.id,
    fetchPage: fetchConversationPage
  })
  const loading = list.status === 'loading'

  useEffect(() => {
    applyUnreadSnapshot(initialUnread)
  }, [initialUnread])

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
