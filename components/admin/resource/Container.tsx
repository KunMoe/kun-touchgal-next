'use client'

import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  useDisclosure
} from '@heroui/react'
import { ChevronDown, Eye, EyeOff, Search, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { kunFetchDelete, kunFetchGet, kunFetchPut } from '~/utils/kunFetch'
import { errorReporter } from '~/utils/kunErrorHandler'
import { kunDescribeBatchShortfall } from '~/utils/list/kunChunkedBatch'
import { ADMIN_RESOURCE_DELETE_LIMIT } from '~/constants/admin'
import { useEffect, useState, type Key } from 'react'
import { useKunChunkedBatch } from '~/hooks/useKunChunkedBatch'
import { useKunPagedList } from '~/hooks/useKunPagedList'
import { KunListError } from '~/components/kun/ListError'
import { KunTableSkeleton } from '~/components/kun/TableSkeleton'
import { AdminUserFilter } from '../AdminUserFilter'
import { RenderCell } from './RenderCell'
import { useDebounce } from 'use-debounce'
import { KunPagination } from '~/components/kun/Pagination'
import type { AdminResource } from '~/types/api/admin'
import { RESOURCE_STATUS } from '~/constants/contentStatus'

type ResourceSearchType = 'content' | 'info' | 'id' | 'user'
// 批量修改只在公开与隐藏之间切换, 待初审 / 待审是系统态
type ResourceHiddenStatus =
  typeof RESOURCE_STATUS.public | typeof RESOURCE_STATUS.hidden

const columns = [
  { name: '资源标题', id: 'name' },
  { name: '用户', id: 'user' },
  { name: '创建时间', id: 'created' },
  { name: '资源类别', id: 'section' },
  { name: '所属游戏', id: 'patchName' },
  { name: '状态', id: 'status' },
  { name: '操作', id: 'actions' }
]

const searchTypeOptions: Array<{
  key: ResourceSearchType
  label: string
  placeholder: string
}> = [
  {
    key: 'content',
    label: '资源链接',
    placeholder: '输入资源链接（或 BLAKE3 Hash）搜索'
  },
  {
    key: 'info',
    label: '名称备注',
    placeholder: '输入资源名称或备注搜索...'
  },
  { key: 'id', label: '资源 ID', placeholder: '输入资源 ID 搜索...' },
  { key: 'user', label: '用户名', placeholder: '输入用户名搜索...' }
]

interface ResourceQuery {
  page: number
  limit: number
  searchType: ResourceSearchType
  search: string
  userId: number | null
}

const fetchResourcePage = async (query: ResourceQuery) => {
  const params: Record<string, string | number> = {
    page: query.page,
    limit: query.limit
  }
  if (query.searchType === 'id' && query.search) {
    // 资源 ID 是数值入参, 值域由服务端的 kunId 校验, 不当作文本搜索词
    params.resourceId = query.search
  } else if (query.searchType !== 'user' && query.search) {
    params.search = query.search
    params.searchType = query.searchType
  }
  if (query.searchType === 'user' && query.userId) {
    params.userId = query.userId
  }
  const res = await kunFetchGet<{
    resources: AdminResource[]
    total: number
  }>('/admin/resource', params)
  return typeof res === 'string'
    ? res
    : { items: res.resources, total: res.total }
}

interface Props {
  initialResources: AdminResource[]
  initialTotal: number
}

export const Resource = ({ initialResources, initialTotal }: Props) => {
  const list = useKunPagedList<AdminResource, ResourceQuery>({
    query: {
      page: 1,
      limit: 30,
      searchType: 'content',
      search: '',
      userId: null
    },
    initial: { items: initialResources, total: initialTotal },
    getId: (resource) => resource.id,
    clamp: 'toLastPage',
    afterRemove: 'refillIfNext',
    fetchPage: fetchResourcePage
  })
  const { query, selection, setQuery } = list
  const loading = list.status === 'loading'
  const [batchHiding, setBatchHiding] = useState(false)
  const {
    isOpen: isBatchOpen,
    onOpen: onBatchOpen,
    onClose: onBatchClose
  } = useDisclosure()

  const [contentQuery, setContentQuery] = useState('')
  const [debouncedContent] = useDebounce(contentQuery, 500)

  // 分块大小必须不超过后端单次删除上限, 否则整块被校验拒绝; 串行发送避免
  // 同 patch 的删除事务在通告锁上排队占满连接池
  const batch = useKunChunkedBatch({
    chunkSize: ADMIN_RESOURCE_DELETE_LIMIT,
    send: async (chunk) => {
      const res = await kunFetchDelete<KunResponse<{ count: number }>>(
        '/admin/resource',
        { resourceIds: chunk.join(',') }
      )
      if (typeof res === 'string') {
        // 透出服务端原因 (未登录 / 权限 / 校验), 否则汇总 toast 只剩「N 条失败」
        toast.error(res)
        return res
      }
      return res.count
    }
  })

  useEffect(() => {
    setQuery({ search: debouncedContent })
  }, [setQuery, debouncedContent])

  const handleBatchDelete = async () => {
    const result = await batch.run([...selection.ids])
    const unfinished = [...result.failed, ...result.notRun]
    if (unfinished.length) {
      // 失败与没执行的回填选中集, 模态框保持打开供直接重试
      selection.replace(unfinished)
      toast.error(kunDescribeBatchShortfall(result, '删除'))
    } else {
      onBatchClose()
      selection.clear()
      toast.success(`已删除 ${result.succeeded} 条资源`)
    }
    // 批量操作已自行处理选中 (成功清空 / 失败回填), 刷新走后台避免整表骨架屏闪烁
    list.refresh({ background: true })
  }

  const handleBatchStatus = async (status: ResourceHiddenStatus) => {
    setBatchHiding(true)
    const ids = [...selection.ids]

    try {
      const res = await kunFetchPut<KunResponse<{ count: number }>>(
        '/admin/resource/hidden',
        { resourceIds: ids.join(','), status }
      )

      const actionLabel = status === RESOURCE_STATUS.public ? '恢复' : '隐藏'
      if (typeof res === 'string') {
        // 失败时保留选中, 可以直接重试
        toast.error(res)
        return
      } else {
        toast.success(`成功${actionLabel} ${res.count} 条资源`)
      }

      selection.clear()

      // 批量操作已自行清空选中, 刷新走后台避免整表骨架屏闪烁
      list.refresh({ background: true })
    } catch (error) {
      errorReporter(error)
    } finally {
      setBatchHiding(false)
    }
  }

  const handleSearchTypeChange = (keys: 'all' | Set<Key>) => {
    const key = Array.from(keys)[0] as ResourceSearchType | undefined
    if (!key) {
      return
    }
    setContentQuery('')
    setQuery({ searchType: key, search: '', userId: null })
  }

  const selectedCount = selection.ids.size

  const currentPlaceholder =
    searchTypeOptions.find((o) => o.key === query.searchType)?.placeholder ?? ''

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">下载资源管理</h1>
        <div className="flex items-center gap-2">
          {selectedCount > 0 && (
            <>
              <Dropdown>
                <DropdownTrigger>
                  <Button
                    color="warning"
                    variant="flat"
                    size="sm"
                    endContent={<ChevronDown size={14} />}
                    isLoading={batchHiding}
                  >
                    修改状态 ({selectedCount})
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label="批量修改资源状态"
                  onAction={(key) =>
                    handleBatchStatus(Number(key) as ResourceHiddenStatus)
                  }
                >
                  <DropdownItem
                    key={RESOURCE_STATUS.hidden}
                    startContent={<EyeOff size={14} />}
                  >
                    隐藏
                  </DropdownItem>
                  <DropdownItem
                    key={RESOURCE_STATUS.public}
                    startContent={<Eye size={14} />}
                  >
                    恢复
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
              <Button
                color="danger"
                variant="flat"
                size="sm"
                startContent={<Trash2 size={14} />}
                onPress={onBatchOpen}
              >
                批量删除 ({selectedCount})
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Select
          aria-label="搜索类型"
          className="w-full sm:max-w-40"
          selectedKeys={new Set([query.searchType])}
          onSelectionChange={handleSearchTypeChange}
        >
          {searchTypeOptions.map((option) => (
            <SelectItem key={option.key}>{option.label}</SelectItem>
          ))}
        </Select>

        {query.searchType === 'user' ? (
          <AdminUserFilter
            placeholder={currentPlaceholder}
            onChange={(userId) => setQuery({ userId })}
          />
        ) : (
          <Input
            fullWidth
            isClearable
            maxLength={300}
            placeholder={currentPlaceholder}
            startContent={<Search className="text-default-300" size={20} />}
            value={contentQuery}
            onValueChange={setContentQuery}
          />
        )}
      </div>

      {loading ? (
        <KunTableSkeleton />
      ) : list.status === 'error' ? (
        <KunListError
          message={list.error ?? ''}
          onRetry={() => list.refresh()}
        />
      ) : (
        <Table
          aria-label="资源管理列表"
          selectionMode="multiple"
          // 选中集一律是显式的 id: 表头全选 ('all') 当场展开成本页可见的行, 之后补齐
          // 换入的新行不会被批量带上 (react-stately 对包含全部可见 key 的集合照样显示全选)
          selectedKeys={new Set([...selection.ids].map(String))}
          onSelectionChange={(keys) =>
            selection.replace(
              keys === 'all'
                ? list.items.map((resource) => resource.id)
                : Array.from(keys).map(Number)
            )
          }
          bottomContent={
            <div className="flex justify-center w-full">
              <KunPagination
                total={Math.ceil(list.total / query.limit)}
                onPageChange={list.setPage}
                isLoading={loading}
                page={query.page}
              />
            </div>
          }
        >
          <TableHeader columns={columns}>
            {(column) => (
              <TableColumn key={column.id}>{column.name}</TableColumn>
            )}
          </TableHeader>
          <TableBody>
            {list.items.map((item) => (
              <TableRow key={item.id}>
                {columns.map((column) => (
                  <TableCell key={column.id}>
                    {RenderCell(item, column.id, {
                      // 单条编辑后就地更新该行, 不整表刷新
                      onUpdated: (updated) =>
                        list.patchLocal(updated.id, updated),
                      onDeleted: (resourceId) => list.removeLocal([resourceId])
                    })}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

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
              setQuery({ limit: val })
            }
          }}
        >
          <SelectItem key="30">30</SelectItem>
          <SelectItem key="50">50</SelectItem>
          <SelectItem key="100">100</SelectItem>
          <SelectItem key="500">500</SelectItem>
        </Select>
        <span>条，共 {list.total} 条</span>
      </div>

      {/* 批量进行中不可关闭: 关掉弹窗不会停下循环 (P22-01), 要停用「停止剩余」 */}
      <Modal
        isOpen={isBatchOpen}
        onClose={onBatchClose}
        placement="center"
        isDismissable={!batch.isRunning}
        isKeyboardDismissDisabled={batch.isRunning}
        hideCloseButton={batch.isRunning}
      >
        <ModalContent>
          <ModalHeader>批量删除资源</ModalHeader>
          <ModalBody>
            <p>
              您确定要删除选中的 <strong>{selectedCount}</strong>{' '}
              条资源吗？该操作不可撤销。
            </p>
            {batch.progress && (
              <p className="text-sm text-default-500">
                正在删除 {batch.progress.sent} / {batch.progress.total}
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            {batch.isRunning ? (
              <Button
                variant="light"
                onPress={batch.stop}
                isDisabled={batch.isStopping}
              >
                停止剩余
              </Button>
            ) : (
              <Button variant="light" onPress={onBatchClose}>
                取消
              </Button>
            )}
            <Button
              color="danger"
              onPress={handleBatchDelete}
              isLoading={batch.isRunning}
            >
              确认删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  )
}
