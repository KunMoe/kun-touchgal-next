'use client'

import { useEffect, useState } from 'react'
import { useMounted } from '~/hooks/useMounted'
import { KunLoading } from '~/components/kun/Loading'
import { MessageCard } from './MessageCard'
import { kunFetchDelete, kunFetchGet } from '~/utils/kunFetch'
import { KunNull } from '~/components/kun/Null'
import { MESSAGE_TYPE } from '~/constants/message'
import toast from 'react-hot-toast'
import { KunPagination } from '~/components/kun/Pagination'
import { Button } from '@heroui/react'
import { Trash2 } from 'lucide-react'
import type { Message } from '~/types/api/message'

interface Props {
  initialMessages: Message[]
  total: number
  type?: (typeof MESSAGE_TYPE)[number]
}

export const MessageContainer = ({ initialMessages, total, type }: Props) => {
  const currentType = type ?? ''
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [messageTotal, setMessageTotal] = useState(total)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [page, setPage] = useState(1)
  const isMounted = useMounted()

  const fetchMessages = async (targetPage: number) => {
    try {
      setLoading(true)

      const response = await kunFetchGet<
        KunResponse<{
          messages: Message[]
          total: number
        }>
      >('/message/all', {
        ...(currentType ? { type: currentType } : {}),
        page: targetPage,
        limit: 30
      })
      if (typeof response === 'string') {
        toast.error(response)
      } else {
        setMessages(response.messages)
        setMessageTotal(response.total)
      }
    } catch {
      toast.error('获取消息失败, 请稍后重试')
    } finally {
      setLoading(false)
    }
  }

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

      if (page !== 1) {
        setPage(1)
      } else {
        await fetchMessages(1)
      }
    } catch {
      toast.error('清理已读信息失败, 请稍后重试')
    } finally {
      setClearing(false)
    }
  }

  useEffect(() => {
    if (!isMounted) {
      return
    }
    fetchMessages(page)
  }, [page])

  return (
    <div className="space-y-4">
      <Button
        color="danger"
        variant="flat"
        startContent={<Trash2 className="size-4" />}
        isDisabled={loading || clearing || !messageTotal}
        isLoading={clearing}
        onPress={handleClearReadMessages}
        fullWidth
      >
        清理已读信息
      </Button>

      {loading ? (
        <KunLoading hint="正在获取消息数据..." />
      ) : !messages.length ? (
        <KunNull message="暂无消息" />
      ) : (
        <div className="space-y-4">
          {messages.map((msg) => (
            <MessageCard key={msg.id} msg={msg} />
          ))}
        </div>
      )}

      {messageTotal > 30 && (
        <div className="flex justify-center">
          <KunPagination
            total={Math.ceil(messageTotal / 30)}
            page={page}
            onPageChange={setPage}
            isLoading={loading}
          />
        </div>
      )}
    </div>
  )
}
