'use client'

import { useEffect, useRef, useState } from 'react'
import { kunFetchGet } from '~/utils/kunFetch'
import { errorReporter } from '~/utils/kunErrorHandler'
import { KunCardSkeleton } from '~/components/kun/CardSkeleton'
import { useMounted } from '~/hooks/useMounted'
import { LogCard } from './Card'
import toast from 'react-hot-toast'
import { KunPagination } from '~/components/kun/Pagination'
import type { AdminLog } from '~/types/api/admin'

interface Props {
  initialLogs: AdminLog[]
  total: number
}

export const Log = ({ initialLogs, total: initialTotal }: Props) => {
  const [logs, setLogs] = useState<AdminLog[]>(initialLogs)
  const [total, setTotal] = useState(initialTotal)
  const [page, setPage] = useState(1)
  const isMounted = useMounted()

  const [loading, setLoading] = useState(false)
  const latestFetchRequestIdRef = useRef(0)
  const fetchData = async () => {
    const requestId = latestFetchRequestIdRef.current + 1
    latestFetchRequestIdRef.current = requestId
    setLoading(true)
    try {
      const response = await kunFetchGet<
        KunResponse<{
          logs: AdminLog[]
          total: number
        }>
      >('/admin/log', {
        page,
        limit: 30
      })
      if (requestId !== latestFetchRequestIdRef.current) {
        return
      }
      if (typeof response === 'string') {
        toast.error(response)
        return
      }
      setLogs(response.logs)
      setTotal(response.total)
    } catch (error) {
      if (requestId !== latestFetchRequestIdRef.current) {
        return
      }
      errorReporter(error)
    } finally {
      if (requestId === latestFetchRequestIdRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!isMounted) {
      return
    }
    fetchData()
  }, [page])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">管理日志</h1>

      <div className="space-y-4">
        {loading ? (
          <KunCardSkeleton count={3} />
        ) : (
          <>
            {logs.map((log) => (
              <LogCard key={log.id} log={log} />
            ))}
          </>
        )}
      </div>

      <div className="flex justify-center">
        <KunPagination
          total={Math.ceil(total / 30)}
          page={page}
          onPageChange={setPage}
          isLoading={loading}
        />
      </div>
    </div>
  )
}
