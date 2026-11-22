'use client'

import { useState } from 'react'
import { KunLoading } from '~/components/kun/Loading'
import { KunListError } from '~/components/kun/ListError'
import { MessageCard } from './MessageCard'
import { kunFetchDelete, kunFetchGet } from '~/utils/kunFetch'
import { KunNull } from '~/components/kun/Null'
import { MESSAGE_TYPE } from '~/constants/message'
import toast from 'react-hot-toast'
import { KunPagination } from '~/components/kun/Pagination'
import { Button } from '@heroui/react'
import { Trash2 } from 'lucide-react'
import { useKunPagedList } from '~/hooks/useKunPagedList'
import type { Message } from '~/types/api/message'

interface Props {
  initialMessages: Message[]
  total: number
  type?: (typeof MESSAGE_TYPE)[number]
}

interface MessageQuery {
  page: number
  limit: number
  // 空串为全部类型。每个类型是单独的路由, 挂载后不变
  type: (typeof MESSAGE_TYPE)[number] | ''
}

const fetchMessagePage = async (query: MessageQuery) => {
  const response = await kunFetchGet<
    KunResponse<{
      messages: Message[]
      total: number
    }>
  >('/message/all', {
    ...(query.type ? { type: query.type } : {}),
    page: query.page,
    limit: query.limit
  })
  return typeof response === 'string'
    ? response
    : { items: response.messages, total: response.total }
}

export const MessageContainer = ({ initialMessages, total, type }: Props) => {
  const currentType = type ?? ''
  const list = useKunPagedList<Message, MessageQuery>({
    query: { page: 1, limit: 30, type: currentType },
    initial: { items: initialMessages, total },
    getId: (msg) => msg.id,
    fetchPage: fetchMessagePage
  })
  const loading = list.status === 'loading'
  const [clearing, setClearing] = useState(false)

  const handleClearReadMessages = async () => {
    try {
      setClearing(true)

      const response = await kunFetchDelete<KunResponse<{}>>('/message/read', {
        type: currentType
      })
      if (typeof response === 'string') {
        toast.error(response)
        return
      }

      toast.success('已清理已读信息')

      if (list.query.page !== 1) {
        list.setPage(1)
      } else {
        list.refresh()
      }
    } catch {
      toast.error('清理已读信息失败, 请稍后重试')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="space-y-4">
      <Button
        color="danger"
        variant="flat"
        startContent={<Trash2 className="size-4" />}
        isDisabled={loading || clearing || !list.total}
        isLoading={clearing}
        onPress={handleClearReadMessages}
        fullWidth
      >
        清理已读信息
      </Button>

      {loading ? (
        <KunLoading hint="正在获取消息数据..." />
      ) : list.status === 'error' ? (
        <KunListError
          message={list.error ?? ''}
          onRetry={() => list.refresh()}
        />
      ) : !list.items.length ? (
        <KunNull message="暂无消息" />
      ) : (
        <div className="space-y-4">
          {list.items.map((msg) => (
            <MessageCard key={msg.id} msg={msg} />
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
