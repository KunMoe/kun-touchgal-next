'use client'

import {
  Autocomplete,
  AutocompleteItem,
  Avatar,
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
import { kunShouldBackfillDeletedRow } from '~/utils/pagination'
import { ADMIN_RESOURCE_DELETE_LIMIT } from '~/constants/admin'
import { useEffect, useRef, useState, type Key } from 'react'
import type { Selection } from '@heroui/table'
import { useMounted } from '~/hooks/useMounted'
import { KunTableSkeleton } from '~/components/kun/TableSkeleton'
import { RenderCell } from './RenderCell'
import { useDebounce } from 'use-debounce'
import { KunPagination } from '~/components/kun/Pagination'
import type { AdminResource, AdminUser } from '~/types/api/admin'
import type { PatchResource } from '~/types/api/patch'

type ResourceSearchType = 'content' | 'info' | 'user'

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
  { key: 'user', label: '用户名', placeholder: '输入用户名搜索...' }
]

interface UserOption {
  id: number
  name: string
  avatar: string
}

interface Props {
  initialResources: AdminResource[]
  initialTotal: number
}

export const Resource = ({ initialResources, initialTotal }: Props) => {
  const [resources, setResources] = useState<AdminResource[]>(initialResources)
  const [total, setTotal] = useState(initialTotal)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(30)
  const [searchType, setSearchType] = useState<ResourceSearchType>('content')
  const [selectedKeys, setSelectedKeys] = useState<Selection>(new Set())
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState('')
  const [batchHiding, setBatchHiding] = useState(false)
  const {
    isOpen: isBatchOpen,
    onOpen: onBatchOpen,
    onClose: onBatchClose
  } = useDisclosure()

  const [contentQuery, setContentQuery] = useState('')
  const [debouncedContent] = useDebounce(contentQuery, 500)

  const [userInput, setUserInput] = useState('')
  const [debouncedUserInput] = useDebounce(userInput, 400)
  const [userOptions, setUserOptions] = useState<UserOption[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [userSearchLoading, setUserSearchLoading] = useState(false)

  const isMounted = useMounted()
  const [loading, setLoading] = useState(false)
  // 页码钳制帧列表已清空而 refetch 尚未发起, 渲染层以骨架屏遮住误导空态
  const [clampRefetchPending, setClampRefetchPending] = useState(false)

  useEffect(() => {
    if (!debouncedUserInput.trim()) {
      setUserOptions([])
      return
    }
    let cancelled = false
    const fetchUsers = async () => {
      setUserSearchLoading(true)
      try {
        const res = await kunFetchGet<{
          users: AdminUser[]
          total: number
        }>('/admin/user', {
          page: 1,
          limit: 10,
          search: debouncedUserInput,
          searchType: 'name'
        })
        if (!cancelled) {
          if (typeof res === 'string') {
            toast.error(res)
          } else {
            setUserOptions(
              res.users.map((u) => ({
                id: u.id,
                name: u.name,
                avatar: u.avatar
              }))
            )
          }
        }
      } finally {
        if (!cancelled) {
          setUserSearchLoading(false)
        }
      }
    }
    fetchUsers()
    return () => {
      cancelled = true
    }
  }, [debouncedUserInput])

  const latestFetchRequestIdRef = useRef(0)
  // 本渲染时刻的请求序号; 删行/批量后刷新前比对, 若期间有过新请求 (翻页/筛选
  // 变更) 则闭包参数已过期, 跳过静默刷新让用户请求的响应落地
  const renderFetchRequestId = latestFetchRequestIdRef.current

  const fetchData = async ({ silent = false } = {}) => {
    const requestId = latestFetchRequestIdRef.current + 1
    latestFetchRequestIdRef.current = requestId
    if (!silent) {
      setLoading(true)
      setClampRefetchPending(false)
    }
    try {
      const params: Record<string, string | number> = { page, limit }
      if (searchType !== 'user' && debouncedContent) {
        params.search = debouncedContent
        params.searchType = searchType
      }
      if (searchType === 'user' && selectedUserId) {
        params.userId = selectedUserId
      }

      const res = await kunFetchGet<{
        resources: AdminResource[]
        total: number
      }>('/admin/resource', params)

      if (requestId !== latestFetchRequestIdRef.current) {
        return
      }

      if (typeof res === 'string') {
        // 静默刷新失败不提示: 刚展示过操作成功的 toast, 紧跟报错只会误导
        if (!silent) {
          toast.error(res)
        }
        return
      }

      const totalPage = Math.max(1, Math.ceil(res.total / limit))
      if (page > totalPage) {
        setPage(totalPage)
        setClampRefetchPending(true)
      }

      setResources(res.resources)
      setTotal(res.total)
      if (!silent) {
        setSelectedKeys(new Set<string | number>())
      }
    } catch (error) {
      if (silent || requestId !== latestFetchRequestIdRef.current) {
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
  }, [page, limit, searchType, debouncedContent, selectedUserId])

  const selectedCount =
    selectedKeys === 'all' ? resources.length : selectedKeys.size

  // 单条编辑后就地更新该行, 不整表刷新
  const handleResourceUpdated = (updated: PatchResource) => {
    setResources((prev) =>
      prev.map((resource) =>
        resource.id === updated.id ? { ...resource, ...updated } : resource
      )
    )
  }

  // 单条删除后只移除该行; 当前页被抽空且不在第一页时回退页码走正常 refetch
  const handleResourceDeleted = (resourceId: number) => {
    if (resources.length === 1 && page > 1) {
      setSelectedKeys(new Set<string | number>())
      setPage(page - 1)
      return
    }
    setSelectedKeys((prev) => {
      if (prev === 'all') {
        return prev
      }
      const next = new Set(
        [...prev].filter((key) => Number(key) !== resourceId)
      )
      return next.size === prev.size ? prev : next
    })
    setResources((prev) =>
      prev.filter((resource) => resource.id !== resourceId)
    )
    setTotal((prev) => Math.max(0, prev - 1))
    if (
      kunShouldBackfillDeletedRow(total, page, limit) &&
      latestFetchRequestIdRef.current === renderFetchRequestId
    ) {
      // 'all' 的语义是「当前页全部」, 补齐会换入未展示过的新行,
      // 先清空选中避免批量操作误伤
      if (selectedKeys === 'all') {
        setSelectedKeys(new Set<string | number>())
      }
      fetchData({ silent: true })
    }
  }

  const handleBatchDelete = async () => {
    setBatchDeleting(true)
    const ids =
      selectedKeys === 'all'
        ? resources.map((r) => r.id)
        : Array.from(selectedKeys).map(Number)

    // 分块大小必须不超过后端单次删除上限, 否则整块被校验拒绝; 串行发送避免
    // 同 patch 的删除事务在通告锁上排队占满连接池
    const chunkSize = ADMIN_RESOURCE_DELETE_LIMIT
    try {
      let deletedCount = 0
      const failedIds: number[] = []
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize)
        setDeleteProgress(
          `${Math.min(i + chunkSize, ids.length)} / ${ids.length}`
        )
        try {
          const res = await kunFetchDelete<KunResponse<{ count: number }>>(
            '/admin/resource',
            { resourceIds: chunk.join(',') }
          )
          if (typeof res === 'string') {
            // 透出服务端原因 (未登录 / 权限 / 校验), 否则汇总 toast 只剩「N 条失败」
            toast.error(res)
            failedIds.push(...chunk)
          } else {
            deletedCount += res.count
          }
        } catch (error) {
          errorReporter(error)
          failedIds.push(...chunk)
        }
      }

      if (failedIds.length) {
        // 失败块回填选中集, 模态框保持打开供直接重试
        setSelectedKeys(new Set(failedIds.map(String)))
        toast.error(
          `已删除 ${deletedCount} 条, ${failedIds.length} 条删除失败, 已保留选中可重试`
        )
      } else {
        onBatchClose()
        setSelectedKeys(new Set<string | number>())
        toast.success(`已删除 ${deletedCount} 条资源`)
      }

      // 批量操作已自行处理选中 (成功清空 / 失败回填), 刷新走 silent 避免整表
      // 骨架屏闪烁且不动选中集; 期间有过新请求 (翻页/筛选变更) 则参数已过期,
      // 跳过让用户请求的响应落地
      if (latestFetchRequestIdRef.current === renderFetchRequestId) {
        await fetchData({ silent: true })
      }
    } finally {
      setBatchDeleting(false)
      setDeleteProgress('')
    }
  }

  const handleBatchStatus = async (status: 0 | 1) => {
    setBatchHiding(true)
    const ids =
      selectedKeys === 'all'
        ? resources.map((r) => r.id)
        : Array.from(selectedKeys).map(Number)

    try {
      const res = await kunFetchPut<KunResponse<{ count: number }>>(
        '/admin/resource/hidden',
        { resourceIds: ids.join(','), status }
      )

      const actionLabel = status === 0 ? '恢复' : '隐藏'
      if (typeof res === 'string') {
        // 失败时保留选中, 可以直接重试
        toast.error(res)
        return
      } else {
        toast.success(`成功${actionLabel} ${res.count} 条资源`)
      }

      setSelectedKeys(new Set<string | number>())

      // 批量操作已自行清空选中, 刷新走 silent 避免整表骨架屏闪烁; 期间有过
      // 新请求 (翻页/筛选变更) 则参数已过期, 跳过让用户请求的响应落地
      if (latestFetchRequestIdRef.current === renderFetchRequestId) {
        await fetchData({ silent: true })
      }
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
    setSearchType(key)
    setPage(1)
    setContentQuery('')
    setUserInput('')
    setSelectedUserId(null)
    setUserOptions([])
  }

  const handleContentSearch = (value: string) => {
    setContentQuery(value)
    setPage(1)
  }

  const handleUserSelectionChange = (key: Key | null) => {
    if (!key) {
      setSelectedUserId(null)
    } else {
      setSelectedUserId(Number(key))
    }
    setPage(1)
  }

  const handleUserInputChange = (value: string) => {
    setUserInput(value)
    if (!value) {
      setSelectedUserId(null)
      setPage(1)
    }
  }

  const currentPlaceholder =
    searchTypeOptions.find((o) => o.key === searchType)?.placeholder ?? ''

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
                  onAction={(key) => handleBatchStatus(Number(key) as 0 | 1)}
                >
                  <DropdownItem key="1" startContent={<EyeOff size={14} />}>
                    隐藏
                  </DropdownItem>
                  <DropdownItem key="0" startContent={<Eye size={14} />}>
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
          selectedKeys={new Set([searchType])}
          onSelectionChange={handleSearchTypeChange}
        >
          {searchTypeOptions.map((option) => (
            <SelectItem key={option.key}>{option.label}</SelectItem>
          ))}
        </Select>

        {searchType === 'user' ? (
          <Autocomplete
            fullWidth
            isClearable
            placeholder={currentPlaceholder}
            startContent={<Search className="text-default-300" size={20} />}
            inputValue={userInput}
            isLoading={userSearchLoading}
            items={userOptions}
            onInputChange={handleUserInputChange}
            onSelectionChange={handleUserSelectionChange}
          >
            {(user) => (
              <AutocompleteItem key={user.id} textValue={user.name}>
                <div className="flex items-center gap-2">
                  <Avatar
                    src={user.avatar}
                    size="sm"
                    showFallback
                    name={user.name.charAt(0).toUpperCase()}
                  />
                  <span>{user.name}</span>
                </div>
              </AutocompleteItem>
            )}
          </Autocomplete>
        ) : (
          <Input
            fullWidth
            isClearable
            maxLength={300}
            placeholder={currentPlaceholder}
            startContent={<Search className="text-default-300" size={20} />}
            value={contentQuery}
            onValueChange={handleContentSearch}
          />
        )}
      </div>

      {loading || clampRefetchPending ? (
        <KunTableSkeleton />
      ) : (
        <Table
          aria-label="资源管理列表"
          selectionMode="multiple"
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
          bottomContent={
            <div className="flex justify-center w-full">
              <KunPagination
                total={Math.ceil(total / limit)}
                onPageChange={setPage}
                isLoading={loading}
                page={page}
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
            {resources.map((item) => (
              <TableRow key={item.id}>
                {columns.map((column) => (
                  <TableCell key={column.id}>
                    {RenderCell(item, column.id, {
                      onUpdated: handleResourceUpdated,
                      onDeleted: handleResourceDeleted
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
          <SelectItem key="500">500</SelectItem>
        </Select>
        <span>条，共 {total} 条</span>
      </div>

      <Modal isOpen={isBatchOpen} onClose={onBatchClose} placement="center">
        <ModalContent>
          <ModalHeader>批量删除资源</ModalHeader>
          <ModalBody>
            <p>
              您确定要删除选中的 <strong>{selectedCount}</strong>{' '}
              条资源吗？该操作不可撤销。
            </p>
            {deleteProgress && (
              <p className="text-sm text-default-500">
                正在删除 {deleteProgress}
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onBatchClose}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleBatchDelete}
              isLoading={batchDeleting}
            >
              确认删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  )
}
