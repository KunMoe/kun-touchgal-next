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
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { errorReporter } from '~/utils/kunErrorHandler'
import { KunCardSkeleton } from '~/components/kun/CardSkeleton'
import { useMounted } from '~/hooks/useMounted'
import { ReportCard } from './ReportCard'
import { KunPagination } from '~/components/kun/Pagination'
import type { AdminReport, AdminReportTargetType } from '~/types/api/admin'

type ReportTab = 'pending' | 'handled'

interface Props {
  initialReports: AdminReport[]
  total: number
  title: string
  targetType: AdminReportTargetType
}

export const Report = ({ initialReports, total, title, targetType }: Props) => {
  const [reports, setReports] = useState<AdminReport[]>(initialReports)
  const [activeTab, setActiveTab] = useState<ReportTab>('pending')
  const [totalCount, setTotalCount] = useState(total)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(30)
  const isMounted = useMounted()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 页码钳制帧列表已清空而 refetch 尚未发起, 渲染层以骨架屏遮住误导空态
  const [clampRefetchPending, setClampRefetchPending] = useState(false)

  const {
    isOpen: isOpenBatch,
    onOpen: onOpenBatch,
    onClose: onCloseBatch
  } = useDisclosure()
  const [selectedReportIds, setSelectedReportIds] = useState<Set<number>>(
    new Set()
  )
  const [batchAction, setBatchAction] = useState<'delete' | 'reject'>('delete')
  const [batchContent, setBatchContent] = useState('')
  const [batching, setBatching] = useState(false)
  const latestFetchRequestIdRef = useRef(0)
  // 本渲染时刻的请求序号; 删行后补齐前比对, 若期间有过新请求 (翻页/筛选变更)
  // 则闭包参数已过期, 跳过静默补齐让用户请求的响应落地
  const renderFetchRequestId = latestFetchRequestIdRef.current

  const fetchData = async (
    targetPage = page,
    targetTab = activeTab,
    { silent = false } = {}
  ) => {
    const requestId = latestFetchRequestIdRef.current + 1
    latestFetchRequestIdRef.current = requestId
    if (!silent) {
      setLoading(true)
      setError('')
      setClampRefetchPending(false)
    }

    try {
      const response = await kunFetchGet<
        KunResponse<{
          reports: AdminReport[]
          total: number
        }>
      >('/admin/report', {
        page: targetPage,
        limit,
        tab: targetTab,
        targetType
      })
      if (requestId !== latestFetchRequestIdRef.current) {
        return
      }
      if (typeof response === 'string') {
        if (!silent) {
          setError(response)
        }
        return
      }
      const totalPage = Math.max(1, Math.ceil(response.total / limit))
      const clamped = targetPage > totalPage
      if (clamped) {
        setPage(totalPage)
        setClampRefetchPending(true)
      }
      setReports(response.reports)
      setTotalCount(response.total)
      // 按「仍在本页且待处理」收敛选中集: 翻页/切 tab 后不可见的举报绝不能
      // 留作批量操作目标; 钳制帧响应是空列表, 过滤会误清已前移行的选中态,
      // 留给 refetch 落地帧
      if (!clamped) {
        setSelectedReportIds((prev) => {
          const selectableIds = new Set(
            response.reports
              .filter((report) => report.status === 0)
              .map((report) => report.id)
          )
          return new Set([...prev].filter((id) => selectableIds.has(id)))
        })
      }
    } catch {
      if (!silent && requestId === latestFetchRequestIdRef.current) {
        setError('网络错误, 请稍后重试')
      }
    } finally {
      if (requestId === latestFetchRequestIdRef.current) {
        setLoading(false)
      }
    }
  }
  // 处理成功后在本地移除该举报 (服务端会一并处理同目标的其他待处理举报),
  // 只有当前页被抽空且不在第一页时才回退页码走正常 refetch。
  // 同目标的其他举报可分布在任意页, 本地递减只是即时反馈,
  // totalCount 须无条件静默 refetch 以服务端为准 (顺带补齐前移行)
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
    const removedIds = reports.filter(isRelated).map((report) => report.id)
    setSelectedReportIds((prev) => {
      if (!removedIds.some((id) => prev.has(id))) {
        return prev
      }
      const next = new Set(prev)
      removedIds.forEach((id) => next.delete(id))
      return next
    })
    if (removedIds.length >= reports.length && page > 1) {
      setPage(page - 1)
      return
    }
    setReports((prev) => prev.filter((report) => !isRelated(report)))
    setTotalCount((prev) => Math.max(0, prev - removedIds.length))
    if (latestFetchRequestIdRef.current === renderFetchRequestId) {
      fetchData(page, activeTab, { silent: true })
    }
  }

  useEffect(() => {
    if (!isMounted) {
      return
    }
    fetchData(page, activeTab)
  }, [page, limit, activeTab, targetType])

  const selectableReports = reports.filter((report) => report.status === 0)
  const isAllSelected =
    selectableReports.length > 0 &&
    selectableReports.every((report) => selectedReportIds.has(report.id))

  const handleReportSelectionChange = (
    reportId: number,
    isSelected: boolean
  ) => {
    setSelectedReportIds((prev) => {
      const next = new Set(prev)
      if (isSelected) {
        next.add(reportId)
      } else {
        next.delete(reportId)
      }
      return next
    })
  }

  const handleToggleSelectAll = () => {
    setSelectedReportIds((prev) => {
      const next = new Set(prev)
      selectableReports.forEach((report) => {
        if (isAllSelected) {
          next.delete(report.id)
        } else {
          next.add(report.id)
        }
      })
      return next
    })
  }

  const handleOpenBatch = (action: 'delete' | 'reject') => {
    setBatchAction(action)
    setBatchContent('')
    onOpenBatch()
  }

  const handleBatch = async () => {
    const reportIds = [...selectedReportIds]
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
        setSelectedReportIds(new Set(res.failedIds))
        toast.error(
          `已${verb} ${res.success} 条举报, ${res.failedIds.length} 条失败${skippedNote}, 已保留失败项选中可重试`
        )
      } else {
        onCloseBatch()
        setBatchContent('')
        setSelectedReportIds(new Set())
        toast.success(`已${verb} ${res.success} 条举报${skippedNote}`)
      }
      await fetchData()
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
        selectedKey={activeTab}
        onSelectionChange={(key) => {
          const nextTab = key.toString() as ReportTab
          if (nextTab === activeTab) {
            return
          }
          setActiveTab(nextTab)
          setPage(1)
        }}
      >
        <Tab key="pending" title="未处理" />
        <Tab key="handled" title="已处理" />
      </Tabs>

      {activeTab === 'pending' ? (
        <div className="flex flex-wrap items-center gap-2">
          {selectedReportIds.size ? (
            <Chip color="primary" variant="flat">
              {`已选择 ${selectedReportIds.size} 条`}
            </Chip>
          ) : null}
          <Button
            variant="flat"
            onPress={handleToggleSelectAll}
            isDisabled={!selectableReports.length || loading || batching}
          >
            {isAllSelected ? '取消全选' : '全选当前页'}
          </Button>
          <Button
            variant="light"
            onPress={() => setSelectedReportIds(new Set())}
            isDisabled={!selectedReportIds.size || loading || batching}
          >
            清空选择
          </Button>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Button
              color="danger"
              variant="flat"
              onPress={() => handleOpenBatch('delete')}
              isDisabled={!selectedReportIds.size || loading || batching}
            >
              批量删除内容
            </Button>
            <Button
              color="warning"
              variant="flat"
              onPress={() => handleOpenBatch('reject')}
              isDisabled={!selectedReportIds.size || loading || batching}
            >
              批量驳回举报
            </Button>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        {loading || clampRefetchPending ? (
          <KunCardSkeleton count={3} />
        ) : error ? (
          <div className="space-y-3 py-12 text-center">
            <p className="text-danger">{error}</p>
            <Button variant="flat" onPress={() => fetchData()}>
              重试
            </Button>
          </div>
        ) : reports.length ? (
          <>
            {reports.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                isSelected={selectedReportIds.has(report.id)}
                isSelectionDisabled={batching}
                onSelectionChange={(isSelected) =>
                  handleReportSelectionChange(report.id, isSelected)
                }
                onHandled={handleReportsHandled}
              />
            ))}
          </>
        ) : (
          <div className="space-y-1 py-12 text-center">
            <p className="text-default-600">
              {activeTab === 'pending' ? '暂无未处理举报' : '暂无已处理举报'}
            </p>
            <p className="text-sm text-default-500">
              {activeTab === 'pending'
                ? '新举报会在这里排队, 当前无需处理'
                : '处理过的举报会归档在这里, 可切换到「未处理」查看待办'}
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-center">
        <KunPagination
          total={Math.max(1, Math.ceil(totalCount / limit))}
          page={page}
          onPageChange={setPage}
          isLoading={loading}
        />
      </div>

      <div className="flex items-center justify-center gap-2 text-sm text-default-500">
        <span>每页显示</span>
        <Select
          aria-label="每页显示数量"
          size="sm"
          className="w-20"
          selectedKeys={new Set([String(limit)])}
          onSelectionChange={(keys) => {
            const val = Number(Array.from(keys)[0])
            if (val && val !== limit) {
              setLimit(val)
              setPage(1)
            }
          }}
        >
          <SelectItem key="30">30</SelectItem>
          <SelectItem key="50">50</SelectItem>
          <SelectItem key="100">100</SelectItem>
        </Select>
        <span>条，共 {totalCount} 条</span>
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
              {selectedReportIds.size} 条举报, 回复内容对每条举报生效,
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
