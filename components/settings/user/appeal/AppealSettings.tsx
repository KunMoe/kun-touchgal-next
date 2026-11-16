'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Select, SelectItem } from '@heroui/select'
import { kunFetchGet } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import { KunLoading } from '~/components/kun/Loading'
import { KunPagination } from '~/components/kun/Pagination'
import { useMounted } from '~/hooks/useMounted'
import { AppealCard, stateChipMap } from './AppealCard'
import type { UserAppealItem, UserAppealState } from '~/types/api/appeal'

type StateFilter = UserAppealState | 'all'

const stateFilterOptions = [
  { key: 'all', label: '全部' },
  ...Object.entries(stateChipMap).map(([key, { label }]) => ({ key, label }))
]

// 通知等入口用 ?state= 指定筛选 (见 APPEAL_APPROVED_LINK); 不带或取值无效时只显示可申诉内容
const getUrlState = (searchParams: URLSearchParams): StateFilter => {
  const value = searchParams.get('state')
  return stateFilterOptions.some((option) => option.key === value)
    ? (value as StateFilter)
    : 'appealable'
}

export const AppealSettings = () => {
  const searchParams = useSearchParams()
  const [appeals, setAppeals] = useState<UserAppealItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [state, setState] = useState(() => getUrlState(searchParams))
  const [loading, setLoading] = useState(false)
  const limit = 10
  const isMounted = useMounted()
  // 陈旧响应守卫: 分页输入框在 loading 期间仍可跳页, 慢响应不得覆盖新页数据
  const latestFetchRequestIdRef = useRef(0)

  const fetchData = async () => {
    const requestId = latestFetchRequestIdRef.current + 1
    latestFetchRequestIdRef.current = requestId
    setLoading(true)
    let clamped = false
    try {
      const response = await kunFetchGet<
        KunResponse<{ appeals: UserAppealItem[]; total: number }>
      >('/user/appeal', { page, limit, state })
      if (requestId !== latestFetchRequestIdRef.current) {
        return
      }
      kunErrorHandler(response, (value) => {
        // 筛选下条目会离开列表 (提交申诉后不再是可申诉): 当前页因此越界时退回最后一页
        // 重新获取, 期间保持 loading, 不把越界页的空列表当成空态展示
        const totalPage = Math.max(1, Math.ceil(value.total / limit))
        if (page > totalPage) {
          clamped = true
          setPage(totalPage)
          return
        }
        setAppeals(value.appeals)
        setTotal(value.total)
      })
    } catch (error) {
      errorReporter(error)
    } finally {
      if (requestId === latestFetchRequestIdRef.current && !clamped) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!isMounted) {
      return
    }
    fetchData()
  }, [isMounted, page, state])

  // 已在本页时再点这类链接, 筛选也跟着链接走: 带 ?state= 的切到对应状态, 不带的回到可申诉
  useEffect(() => {
    setState(getUrlState(searchParams))
    setPage(1)
  }, [searchParams])

  return (
    <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
        <h2 className="text-xl font-semibold text-foreground">内容申诉</h2>
        <p className="max-w-2xl leading-6 text-default-500">
          未通过内容审核而被隐藏的评论、评价与资源会显示在这里。您可以修改内容后提交申诉，由管理员人工复核；申诉通过后内容将恢复展示，申诉被拒绝后内容将被删除。
        </p>
      </CardHeader>
      <CardBody className="space-y-4 overflow-visible px-5 py-4">
        <Select
          aria-label="申诉状态筛选"
          className="w-full sm:max-w-40"
          selectedKeys={[state]}
          onChange={(event) => {
            if (!event.target.value) {
              return
            }
            setState(event.target.value as StateFilter)
            setPage(1)
          }}
        >
          {stateFilterOptions.map((option) => (
            <SelectItem key={option.key}>{option.label}</SelectItem>
          ))}
        </Select>

        {!isMounted || loading ? (
          <KunLoading hint="正在获取申诉记录..." />
        ) : appeals.length ? (
          appeals.map((item) => (
            <AppealCard key={item.taskId} item={item} onRefresh={fetchData} />
          ))
        ) : (
          <div className="space-y-1 py-12 text-center text-default-500">
            <p>
              {state === 'all'
                ? '暂无被拒的内容'
                : `暂无${stateChipMap[state].label}的内容`}
            </p>
            {state === 'appealable' && (
              <p className="text-sm text-default-400">
                已提交的申诉可切换上方的状态筛选查看
              </p>
            )}
          </div>
        )}

        {total > limit && (
          <div className="flex justify-center">
            <KunPagination
              total={Math.max(1, Math.ceil(total / limit))}
              page={page}
              onPageChange={setPage}
              isLoading={loading}
            />
          </div>
        )}
      </CardBody>
    </Card>
  )
}
