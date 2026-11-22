'use client'

import {
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Tab,
  Tabs,
  Textarea,
  useDisclosure
} from '@heroui/react'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { errorReporter } from '~/utils/kunErrorHandler'
import { KunCardSkeleton } from '~/components/kun/CardSkeleton'
import { KunListError } from '~/components/kun/ListError'
import { useKunPagedList } from '~/hooks/useKunPagedList'
import { ReportCard } from './ReportCard'
import { KunPagination } from '~/components/kun/Pagination'
import type { AdminReport, AdminReportTargetType } from '~/types/api/admin'

type ReportTab = 'pending' | 'handled'

interface ReportQuery {
  page: number
  limit: number
  tab: ReportTab
  targetType: AdminReportTargetType
}

const fetchReportPage = async (query: ReportQuery) => {
  const response = await kunFetchGet<
    KunResponse<{
      reports: AdminReport[]
      total: number
    }>
  >('/admin/report', {
    page: query.page,
    limit: query.limit,
    tab: query.tab,
    targetType: query.targetType
  })
  return typeof response === 'string'
    ? response
    : { items: response.reports, total: response.total }
}

interface Props {
  initialReports: AdminReport[]
  total: number
  title: string
  targetType: AdminReportTargetType
}

export const Report = ({ initialReports, total, title, targetType }: Props) => {
  const list = useKunPagedList<AdminReport, ReportQuery>({
    query: { page: 1, limit: 30, tab: 'pending', targetType },
    initial: { items: initialReports, total },
    getId: (report) => report.id,
    clamp: 'toLastPage',
    // 同目标的其他举报会被服务端一并处理, 它们可分布在任意页: 本地递减只是即时反馈,
    // 无条件静默补齐以服务端为准 (顺带补上前移的行)
    afterRemove: 'alwaysRefill',
    // 翻页 / 切 tab 后不可见的、已处理的举报绝不能留作批量操作目标
    isSelectable: (report) => report.status === 0,
    fetchPage: fetchReportPage
  })
  const { query, selection } = list
  const loading = list.status === 'loading'

  const {
    isOpen: isOpenBatch,
    onOpen: onOpenBatch,
    onClose: onCloseBatch
  } = useDisclosure()
  const [batchAction, setBatchAction] = useState<'delete' | 'reject'>('delete')
  const [batchContent, setBatchContent] = useState('')
  const [batching, setBatching] = useState(false)

  // 处理成功后在本地移除该举报与本页里同目标的其他举报 (服务端会一并处理它们)
  const handleReportsHandled = (handled: AdminReport) => {
    const targetId =
      handled.targetType === 'comment'
        ? handled.comment?.id
        : handled.rating?.id
    const isRelated = (report: AdminReport) => {
      if (report.id === handled.id) {
        return true
      }
      if (!targetId || report.targetType !== handled.targetType) {
        return false
      }
      const reportTargetId =
        handled.targetType === 'comment'
          ? report.comment?.id
          : report.rating?.id
      return reportTargetId === targetId
    }
    list.removeLocal(list.items.filter(isRelated).map((report) => report.id))
  }

  const hasSelectableReport = list.items.some((report) => report.status === 0)

  const handleOpenBatch = (action: 'delete' | 'reject') => {
    setBatchAction(action)
    setBatchContent('')
    onOpenBatch()
  }

  const handleBatch = async () => {
    const reportIds = [...selection.ids]
    if (!reportIds.length) {
      return
    }
    setBatching(true)
    try {
      const res = await kunFetchPost<
        KunResponse<{ success: number; skipped: number; failedIds: number[] }>
      >('/admin/report/handle/batch', {
        reportIds,
        action: batchAction,
        content: batchContent.trim()
      })
      if (typeof res === 'string') {
        toast.error(res)
        return
      }
      const verb = batchAction === 'reject' ? '驳回' : '删除内容并处理'
      const skippedNote = res.skipped ? `, ${res.skipped} 条已被连带处理` : ''
      if (res.failedIds.length) {
        selection.replace(res.failedIds)
        toast.error(
          `已${verb} ${res.success} 条举报, ${res.failedIds.length} 条失败${skippedNote}, 已保留失败项选中可重试`
        )
      } else {
        onCloseBatch()
        setBatchContent('')
        selection.clear()
        toast.success(`已${verb} ${res.success} 条举报${skippedNote}`)
      }
      list.refresh()
    } catch (error) {
      errorReporter(error)
    } finally {
      setBatching(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Tabs
        selectedKey={query.tab}
        onSelectionChange={(key) =>
          list.setQuery({ tab: key.toString() as ReportTab })
        }
      >
        <Tab key="pending" title="未处理" />
        <Tab key="handled" title="已处理" />
      </Tabs>

      {query.tab === 'pending' ? (
        <div className="flex flex-wrap items-center gap-2">
          {selection.ids.size ? (
            <Chip color="primary" variant="flat">
              {`已选择 ${selection.ids.size} 条`}
            </Chip>
          ) : null}
          <Button
            variant="flat"
            onPress={selection.togglePage}
            isDisabled={!hasSelectableReport || loading || batching}
          >
            {selection.isPageSelected ? '取消全选' : '全选当前页'}
          </Button>
          <Button
            variant="light"
            onPress={selection.clear}
            isDisabled={!selection.ids.size || loading || batching}
          >
            清空选择
          </Button>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Button
              color="danger"
              variant="flat"
              onPress={() => handleOpenBatch('delete')}
              isDisabled={!selection.ids.size || loading || batching}
            >
              批量删除内容
            </Button>
            <Button
              color="warning"
              variant="flat"
              onPress={() => handleOpenBatch('reject')}
              isDisabled={!selection.ids.size || loading || batching}
            >
              批量驳回举报
            </Button>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        {loading ? (
          <KunCardSkeleton count={3} />
        ) : list.status === 'error' ? (
          <KunListError
            message={list.error ?? ''}
            onRetry={() => list.refresh()}
          />
        ) : list.items.length ? (
          <>
            {list.items.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                isSelected={selection.ids.has(report.id)}
                isSelectionDisabled={batching}
                onSelectionChange={(isSelected) =>
                  selection.toggle(report.id, isSelected)
                }
                onHandled={handleReportsHandled}
              />
            ))}
          </>
        ) : (
          <div className="space-y-1 py-12 text-center">
            <p className="text-default-600">
              {query.tab === 'pending' ? '暂无未处理举报' : '暂无已处理举报'}
            </p>
            <p className="text-sm text-default-500">
              {query.tab === 'pending'
                ? '新举报会在这里排队, 当前无需处理'
                : '处理过的举报会归档在这里, 可切换到「未处理」查看待办'}
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-center">
        <KunPagination
          total={Math.max(1, Math.ceil(list.total / query.limit))}
          page={query.page}
          onPageChange={list.setPage}
          isLoading={loading}
        />
      </div>

      <div className="flex items-center justify-center gap-2 text-sm text-default-500">
        <span>每页显示</span>
        <Select
          aria-label="每页显示数量"
          size="sm"
          className="w-20"
          selectedKeys={new Set([String(query.limit)])}
          onSelectionChange={(keys) => {
            const val = Number(Array.from(keys)[0])
            if (val && val !== query.limit) {
              list.setQuery({ limit: val })
            }
          }}
        >
          <SelectItem key="30">30</SelectItem>
          <SelectItem key="50">50</SelectItem>
          <SelectItem key="100">100</SelectItem>
        </Select>
        <span>条，共 {list.total} 条</span>
      </div>

      <Modal isOpen={isOpenBatch} onClose={onCloseBatch} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            {batchAction === 'reject'
              ? '批量驳回举报'
              : '批量删除内容并处理举报'}
          </ModalHeader>
          <ModalBody>
            <Textarea
              value={batchContent}
              label="反馈回复内容 (可选)"
              onChange={(e) => setBatchContent(e.target.value)}
              placeholder={
                batchAction === 'reject'
                  ? '留空将使用默认回复：已驳回'
                  : '留空将使用默认回复：已处理'
              }
              minRows={2}
              maxRows={8}
            />
            <p className="text-small text-default-500">
              将{batchAction === 'reject' ? '驳回' : '删除内容并处理'}选中的{' '}
              {selection.ids.size} 条举报, 回复内容对每条举报生效,
              并自动处理同一目标的其他待处理举报
            </p>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              onPress={() => {
                setBatchContent('')
                onCloseBatch()
              }}
              isDisabled={batching}
            >
              取消
            </Button>
            <Button
              color={batchAction === 'reject' ? 'warning' : 'danger'}
              onPress={handleBatch}
              isDisabled={batching}
              isLoading={batching}
            >
              {batchAction === 'reject' ? '确认批量驳回' : '确认批量删除'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  )
}
