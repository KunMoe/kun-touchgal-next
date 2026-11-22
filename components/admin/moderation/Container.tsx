'use client'

import {
  Button,
  Card,
  CardBody,
  Chip,
  Input,
  Select,
  SelectItem
} from '@heroui/react'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { useEffect, useState, type Key } from 'react'
import toast from 'react-hot-toast'
import {
  kunFetchDelete,
  kunFetchGet,
  kunFetchPost,
  kunFetchPut
} from '~/utils/kunFetch'
import { errorReporter } from '~/utils/kunErrorHandler'
import { KunCardSkeleton } from '~/components/kun/CardSkeleton'
import { KunListError } from '~/components/kun/ListError'
import { KunPagination } from '~/components/kun/Pagination'
import { useKunPagedList } from '~/hooks/useKunPagedList'
import { canReviewModerationTask, ModerationTaskCard } from './Card'
import { ModerationHealth } from './Health'
import {
  formatModerationContentTypeLabel,
  MODERATION_CONTENT_TYPE_MAP,
  MODERATION_FAILURE_KIND_MAP,
  MODERATION_TASK_STATUS_MAP,
  MODERATION_TEXT_CONTENT_TYPE
} from '~/constants/moderation'
import { DELETED_USER_NAME } from '~/constants/user'
import type {
  AdminModerationBlacklistItem,
  AdminModerationStats,
  AdminModerationTask
} from '~/types/api/admin'

const statusFilterOptions = [
  { key: 'all', label: '全部' },
  ...Object.entries(MODERATION_TASK_STATUS_MAP).map(([key, label]) => ({
    key,
    label
  }))
]

const failureKindFilterOptions = [
  { key: 'all', label: '全部失败类别' },
  ...Object.entries(MODERATION_FAILURE_KIND_MAP).map(([key, label]) => ({
    key,
    label
  }))
]

type BatchAction = 'approve' | 'reject' | 'retry'

const batchActionConfig = {
  approve: { title: '批量改判通过', verb: '改判通过', color: 'success' },
  reject: { title: '批量改判拒绝', verb: '改判拒绝', color: 'danger' },
  retry: { title: '批量重试', verb: '重新加入审核队列', color: 'warning' }
} as const

interface ModerationQuery {
  page: number
  limit: number
  status: string
  failureKind: string
}

const fetchModerationPage = async (query: ModerationQuery) => {
  const response = await kunFetchGet<
    KunResponse<{
      tasks: AdminModerationTask[]
      total: number
    }>
  >('/admin/moderation', {
    page: query.page,
    limit: query.limit,
    status: query.status,
    failureKind: query.failureKind
  })
  return typeof response === 'string'
    ? response
    : { items: response.tasks, total: response.total }
}

interface Props {
  initialTasks: AdminModerationTask[]
  initialTotal: number
}

export const Moderation = ({ initialTasks, initialTotal }: Props) => {
  const list = useKunPagedList<AdminModerationTask, ModerationQuery>({
    query: { page: 1, limit: 30, status: 'all', failureKind: 'all' },
    initial: { items: initialTasks, total: initialTotal },
    getId: (task) => task.id,
    clamp: 'toLastPage',
    afterRemove: 'refillIfNext',
    // 按「仍可操作」而非「仍在本页」收敛选中集: 裁决后的任务仍留在列表里,
    // 但已不可再改判, 留在选中集只会虚增计数
    isSelectable: canReviewModerationTask,
    fetchPage: fetchModerationPage
  })
  const { query, selection } = list
  const loading = list.status === 'loading'
  const [stats, setStats] = useState<AdminModerationStats | null>(null)

  const {
    isOpen: isOpenBlacklist,
    onOpen: onOpenBlacklist,
    onClose: onCloseBlacklist
  } = useDisclosure()
  const [blacklist, setBlacklist] = useState<AdminModerationBlacklistItem[]>([])
  const [blacklistPattern, setBlacklistPattern] = useState('')
  const [blacklistTypes, setBlacklistTypes] = useState<string[]>([])
  const [blacklistLoading, setBlacklistLoading] = useState(false)

  const {
    isOpen: isOpenBatch,
    onOpen: onOpenBatch,
    onClose: onCloseBatch
  } = useDisclosure()
  const [batchAction, setBatchAction] = useState<BatchAction>('approve')
  const [batching, setBatching] = useState(false)

  const fetchStats = async () => {
    const res = await kunFetchGet<KunResponse<AdminModerationStats>>(
      '/admin/moderation/stats',
      {}
    )
    if (typeof res !== 'string') {
      setStats(res)
    }
  }

  useEffect(() => {
    fetchStats()
  }, [])

  // 单条改判/重试后只更新对应卡片: 状态或失败类别不再匹配当前筛选时从列表移除,
  // 否则就地更新 (改判与重试都会清掉失败类别)。改判后不可再操作的任务由状态机移出选中集;
  // 离开当前筛选的任务 (如 manual 筛选下重试回 pending) 随删行一并移出
  const handleTaskUpdated = (
    taskId: number,
    patch: Partial<AdminModerationTask>
  ) => {
    const staysVisible =
      (!patch.status ||
        query.status === 'all' ||
        query.status === patch.status) &&
      (patch.failureKind === undefined ||
        query.failureKind === 'all' ||
        query.failureKind === patch.failureKind)
    if (staysVisible) {
      list.patchLocal(taskId, patch)
    } else {
      list.removeLocal([taskId])
    }
    fetchStats()
  }

  const fetchBlacklist = async () => {
    const res = await kunFetchGet<
      KunResponse<{ items: AdminModerationBlacklistItem[] }>
    >('/admin/moderation/blacklist', {})
    if (typeof res === 'string') {
      toast.error(res)
    } else {
      setBlacklist(res.items)
    }
  }

  const handleOpenBlacklist = async (pattern = '') => {
    setBlacklistPattern(pattern)
    setBlacklistTypes([])
    onOpenBlacklist()
    await fetchBlacklist()
  }

  const handleAddBlacklist = async () => {
    if (!blacklistPattern.trim()) {
      return
    }
    setBlacklistLoading(true)
    try {
      const res = await kunFetchPost<KunResponse<{}>>(
        '/admin/moderation/blacklist',
        { pattern: blacklistPattern.trim(), contentTypes: blacklistTypes }
      )
      if (typeof res === 'string') {
        toast.error(res)
        return
      }
      toast.success('已加入黑名单')
      setBlacklistPattern('')
      setBlacklistTypes([])
      await fetchBlacklist()
    } finally {
      setBlacklistLoading(false)
    }
  }

  const handleDeleteBlacklist = async (blacklistId: number) => {
    const res = await kunFetchDelete<KunResponse<{}>>(
      '/admin/moderation/blacklist',
      { blacklistId }
    )
    if (typeof res === 'string') {
      toast.error(res)
      return
    }
    toast.success('已删除黑名单模式')
    await fetchBlacklist()
  }

  const handleStatusChange = (keys: 'all' | Set<Key>) => {
    const key = Array.from(keys)[0] as string | undefined
    if (!key) {
      return
    }
    list.setQuery({ status: key })
  }

  const handleFailureKindChange = (keys: 'all' | Set<Key>) => {
    const key = Array.from(keys)[0] as string | undefined
    if (!key) {
      return
    }
    list.setQuery({ failureKind: key })
  }

  const hasSelectableTask = list.items.some(canReviewModerationTask)
  // 重试的适用面比改判窄, 但客户端提交完整选中集, 由服务端逐条裁决并回报
  // failedIds——否则被静默剔除的任务会永远留在选中集里, 每次都报失败却无法区分
  // 「客户端没提交」与「服务端拒绝」
  const batchTargetIds = [...selection.ids]

  const handleOpenBatch = (action: BatchAction) => {
    setBatchAction(action)
    onOpenBatch()
  }

  const handleBatch = async () => {
    if (!batchTargetIds.length) {
      return
    }
    const { verb } = batchActionConfig[batchAction]
    setBatching(true)
    try {
      const res = await kunFetchPut<
        KunResponse<{ success: number; failedIds: number[] }>
      >('/admin/moderation/batch', {
        taskIds: batchTargetIds,
        action: batchAction
      })
      if (typeof res === 'string') {
        toast.error(res)
        return
      }
      if (res.failedIds.length) {
        selection.replace(res.failedIds)
        const skipped =
          batchTargetIds.length - res.success - res.failedIds.length
        toast.error(
          `已${verb} ${res.success} 个任务, ${res.failedIds.length} 个失败` +
            (skipped > 0 ? `, ${skipped} 个不适用` : '') +
            ', 已保留选中可重试'
        )
      } else {
        onCloseBatch()
        selection.clear()
        toast.success(`已${verb} ${res.success} 个任务`)
      }
      list.refresh()
      await fetchStats()
    } catch (error) {
      errorReporter(error)
    } finally {
      setBatching(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">AI 审核管理</h1>

      {stats && (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-default-500">
              审核统计, 状态与 Token 为近 30 天
            </p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <div>
                <p className="text-sm text-default-500">今日送审</p>
                <p className="text-xl font-semibold">{stats.todayTotal}</p>
              </div>
              {Object.entries(MODERATION_TASK_STATUS_MAP).map(
                ([key, label]) => (
                  <div key={key}>
                    <p className="text-sm text-default-500">{label}</p>
                    <p className="text-xl font-semibold">
                      {stats.statusCounts[key] ?? 0}
                    </p>
                  </div>
                )
              )}
              <div>
                <p className="text-sm text-default-500">Token 入</p>
                <p className="text-xl font-semibold">{stats.tokensIn}</p>
              </div>
              <div>
                <p className="text-sm text-default-500">Token 出</p>
                <p className="text-xl font-semibold">{stats.tokensOut}</p>
              </div>
            </div>
            <ModerationHealth stats={stats} />
          </CardBody>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full flex-wrap gap-3 sm:w-auto">
          <Select
            aria-label="任务状态筛选"
            className="w-full sm:w-40"
            selectedKeys={new Set([query.status])}
            onSelectionChange={handleStatusChange}
          >
            {statusFilterOptions.map((option) => (
              <SelectItem key={option.key}>{option.label}</SelectItem>
            ))}
          </Select>
          <Select
            aria-label="失败类别筛选"
            className="w-full sm:w-44"
            selectedKeys={new Set([query.failureKind])}
            onSelectionChange={handleFailureKindChange}
          >
            {failureKindFilterOptions.map((option) => (
              <SelectItem key={option.key}>{option.label}</SelectItem>
            ))}
          </Select>
        </div>
        <Button variant="flat" onPress={() => handleOpenBlacklist()}>
          黑名单管理
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {selection.ids.size ? (
          <Chip color="primary" variant="flat">
            {`已选择 ${selection.ids.size} 个`}
          </Chip>
        ) : null}
        <Button
          variant="flat"
          onPress={selection.togglePage}
          isDisabled={!hasSelectableTask || loading || batching}
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
            color="warning"
            variant="flat"
            onPress={() => handleOpenBatch('retry')}
            isDisabled={!selection.ids.size || loading || batching}
          >
            批量重试
          </Button>
          <Button
            color="success"
            variant="flat"
            onPress={() => handleOpenBatch('approve')}
            isDisabled={!selection.ids.size || loading || batching}
          >
            批量改判通过
          </Button>
          <Button
            color="danger"
            variant="flat"
            onPress={() => handleOpenBatch('reject')}
            isDisabled={!selection.ids.size || loading || batching}
          >
            批量改判拒绝
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {loading ? (
          <KunCardSkeleton count={3} />
        ) : list.status === 'error' ? (
          <KunListError
            message={list.error ?? ''}
            onRetry={() => list.refresh()}
          />
        ) : list.items.length ? (
          list.items.map((task) => (
            <ModerationTaskCard
              key={task.id}
              task={task}
              isSelected={selection.ids.has(task.id)}
              isSelectionDisabled={batching}
              onSelectionChange={(isSelected) =>
                selection.toggle(task.id, isSelected)
              }
              onTaskUpdated={handleTaskUpdated}
              onAddBlacklist={handleOpenBlacklist}
            />
          ))
        ) : (
          <div className="space-y-1 py-12 text-center">
            <p className="text-default-600">暂无审核任务</p>
            <p className="text-sm text-default-500">
              送审内容会自动进入审核队列, 可切换上方状态筛选查看其他任务
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

      <Modal isOpen={isOpenBatch} onClose={onCloseBatch} placement="center">
        <ModalContent>
          <ModalHeader>{batchActionConfig[batchAction].title}</ModalHeader>
          <ModalBody>
            {batchAction === 'retry'
              ? `确定要将选中的 ${batchTargetIds.length} 个任务重新加入审核队列吗? 仅转人工且无 AI 裁决的任务会被重试, 其余由服务端逐条回报`
              : `确定要将选中的 ${batchTargetIds.length} 个任务改判为${
                  batchAction === 'approve' ? '通过' : '拒绝'
                }吗? 改判会立即对用户内容生效`}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              onPress={onCloseBatch}
              isDisabled={batching}
            >
              取消
            </Button>
            <Button
              color={batchActionConfig[batchAction].color}
              isLoading={batching}
              isDisabled={batching}
              onPress={handleBatch}
            >
              确认{batchActionConfig[batchAction].title}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={isOpenBlacklist}
        onClose={onCloseBlacklist}
        placement="center"
        size="2xl"
      >
        <ModalContent>
          <ModalHeader>审核黑名单管理</ModalHeader>
          <ModalBody className="space-y-4">
            <p className="text-sm text-default-500">
              黑名单为子串匹配（忽略大小写与空白），命中即直接拒绝且不消耗
              Token，请只添加高置信度的违规特征。可选择生效类型，不选则对全部类型生效
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                fullWidth
                placeholder="输入黑名单模式"
                value={blacklistPattern}
                onValueChange={setBlacklistPattern}
              />
              <Select
                aria-label="生效类型"
                selectionMode="multiple"
                placeholder="全部类型"
                className="sm:max-w-44"
                selectedKeys={new Set(blacklistTypes)}
                // 多选模式下 Cmd/Ctrl+A 全选会发出字面量 'all' 而非 Set
                onSelectionChange={(keys) =>
                  setBlacklistTypes(
                    keys === 'all'
                      ? [...MODERATION_TEXT_CONTENT_TYPE]
                      : (Array.from(keys) as string[])
                  )
                }
              >
                {MODERATION_TEXT_CONTENT_TYPE.map((type) => (
                  <SelectItem key={type}>
                    {MODERATION_CONTENT_TYPE_MAP[type]}
                  </SelectItem>
                ))}
              </Select>
              <Button
                color="primary"
                isLoading={blacklistLoading}
                onPress={handleAddBlacklist}
              >
                添加
              </Button>
            </div>
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {blacklist.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-default-100 p-2"
                >
                  <span className="break-all text-sm">{item.pattern}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <Chip size="sm" variant="flat" color="primary">
                      {formatModerationContentTypeLabel(item.contentTypes)}
                    </Chip>
                    <Chip size="sm" variant="flat">
                      {item.user?.name ?? DELETED_USER_NAME}
                    </Chip>
                    <Button
                      size="sm"
                      color="danger"
                      variant="light"
                      onPress={() => handleDeleteBlacklist(item.id)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              ))}
              {!blacklist.length && (
                <p className="py-4 text-center text-sm text-default-500">
                  暂无黑名单模式, 在上方输入高置信度的违规特征,
                  或在任务卡片点击「加入黑名单」快速添加
                </p>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onCloseBlacklist}>
              关闭
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  )
}
