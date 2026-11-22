'use client'

import { Button, Chip, Input, Select, SelectItem } from '@heroui/react'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { Search } from 'lucide-react'
import { useEffect, useState, type Key } from 'react'
import { kunFetchDelete, kunFetchGet } from '~/utils/kunFetch'
import { kunDescribeBatchShortfall } from '~/utils/list/kunChunkedBatch'
import { ADMIN_COMMENT_DELETE_LIMIT } from '~/constants/admin'
import { KunCardSkeleton } from '~/components/kun/CardSkeleton'
import { KunListError } from '~/components/kun/ListError'
import { useKunChunkedBatch } from '~/hooks/useKunChunkedBatch'
import { useKunPagedList } from '~/hooks/useKunPagedList'
import { AdminUserFilter } from '../AdminUserFilter'
import { CommentCard } from './Card'
import { useDebounce } from 'use-debounce'
import { KunPagination } from '~/components/kun/Pagination'
import type { AdminComment } from '~/types/api/admin'
import toast from 'react-hot-toast'

type AdminCommentSearchType = 'content' | 'user'

const searchTypeOptions: Array<{
  key: AdminCommentSearchType
  label: string
  placeholder: string
}> = [
  { key: 'content', label: '评论内容', placeholder: '输入评论内容搜索评论' },
  { key: 'user', label: '用户名', placeholder: '输入用户名搜索...' }
]

interface CommentQuery {
  page: number
  limit: number
  searchType: AdminCommentSearchType
  search: string
  userId: number | null
}

const fetchCommentPage = async (query: CommentQuery) => {
  const params: Record<string, string | number> = {
    page: query.page,
    limit: query.limit,
    searchType: query.searchType
  }
  if (query.searchType === 'content' && query.search) {
    params.search = query.search
  }
  if (query.searchType === 'user' && query.userId) {
    params.userId = query.userId
  }
  const response = await kunFetchGet<
    KunResponse<{
      comments: AdminComment[]
      total: number
    }>
  >('/admin/comment', params)
  return typeof response === 'string'
    ? response
    : { items: response.comments, total: response.total }
}

interface Props {
  initialComments: AdminComment[]
  initialTotal: number
}

export const Comment = ({ initialComments, initialTotal }: Props) => {
  const list = useKunPagedList<AdminComment, CommentQuery>({
    query: {
      page: 1,
      limit: 30,
      searchType: 'content',
      search: '',
      userId: null
    },
    initial: { items: initialComments, total: initialTotal },
    getId: (comment) => comment.id,
    clamp: 'toLastPage',
    // 删除会级联删掉回复, 它们可跨页且是否命中当前筛选客户端不可判定: 本地递减只是
    // 即时反馈, 无条件静默补齐以服务端为准 (顺带补上前移的行)
    afterRemove: 'alwaysRefill',
    fetchPage: fetchCommentPage
  })
  const { query, selection, setQuery } = list
  const loading = list.status === 'loading'

  const [contentQuery, setContentQuery] = useState('')
  const [debouncedContent] = useDebounce(contentQuery, 500)

  const {
    isOpen: isOpenDelete,
    onOpen: onOpenDelete,
    onClose: onCloseDelete
  } = useDisclosure()
  const batch = useKunChunkedBatch({
    // 分块大小必须不超过后端单次删除上限, 否则整块被校验拒绝
    chunkSize: ADMIN_COMMENT_DELETE_LIMIT,
    send: async (chunk) => {
      const res = await kunFetchDelete<KunResponse<{}>>('/admin/comment', {
        commentIds: chunk.join(',')
      })
      return typeof res === 'string' ? res : chunk.length
    }
  })

  useEffect(() => {
    setQuery({ search: debouncedContent })
  }, [setQuery, debouncedContent])

  const handleSearchTypeChange = (keys: 'all' | Set<Key>) => {
    const key = Array.from(keys)[0] as AdminCommentSearchType | undefined
    if (!key) {
      return
    }
    setContentQuery('')
    setQuery({ searchType: key, search: '', userId: null })
  }

  const handleBatchDelete = async () => {
    const ids = [...selection.ids]
    if (!ids.length) {
      return
    }

    const result = await batch.run(ids)
    const unfinished = [...result.failed, ...result.notRun]
    if (unfinished.length) {
      selection.replace(unfinished)
      toast.error(kunDescribeBatchShortfall(result, '删除'))
    } else {
      onCloseDelete()
      selection.clear()
      toast.success(`已删除 ${result.succeeded} 条评论`)
    }
    list.refresh()
  }

  const currentPlaceholder =
    searchTypeOptions.find((option) => option.key === query.searchType)
      ?.placeholder ?? ''

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">评论管理</h1>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row xl:flex-1">
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

        <div className="flex flex-wrap items-center gap-2">
          {selection.ids.size ? (
            <Chip color="primary" variant="flat">
              {`已选择 ${selection.ids.size} 条`}
            </Chip>
          ) : null}
          <Button
            variant="flat"
            onPress={selection.togglePage}
            isDisabled={!list.items.length || loading}
          >
            {selection.isPageSelected ? '取消全选' : '全选当前页'}
          </Button>
          <Button
            variant="light"
            onPress={selection.clear}
            isDisabled={!selection.ids.size || loading}
          >
            清空选择
          </Button>
          <Button
            color="danger"
            onPress={onOpenDelete}
            isDisabled={!selection.ids.size || loading}
          >
            批量删除
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
          <>
            {list.items.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                isSelected={selection.ids.has(comment.id)}
                isSelectionDisabled={batch.isRunning}
                onSelectionChange={(isSelected) =>
                  selection.toggle(comment.id, isSelected)
                }
                // 单条编辑 / 隐藏后就地更新该卡片, 不整表刷新
                onUpdated={(updated) => list.patchLocal(updated.id, updated)}
                // 单条删除后移除该卡片与服务端级联删除的回复
                onDeleted={list.removeLocal}
              />
            ))}
          </>
        ) : (
          <div className="space-y-1 py-12 text-center">
            <p className="text-default-600">暂无评论</p>
            <p className="text-sm text-default-500">
              没有找到符合条件的评论, 可切换搜索类型或修改关键词重试
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-center">
        <KunPagination
          total={Math.ceil(list.total / query.limit)}
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
        isOpen={isOpenDelete}
        onClose={onCloseDelete}
        placement="center"
        isDismissable={!batch.isRunning}
        isKeyboardDismissDisabled={batch.isRunning}
        hideCloseButton={batch.isRunning}
      >
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            批量删除评论
          </ModalHeader>
          <ModalBody>
            <p>
              您确定要删除已选择的 {selection.ids.size} 条评论吗?
              如果这些评论存在回复, 相关回复也会一并删除, 该操作不可撤销
            </p>
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
              <Button variant="light" onPress={onCloseDelete}>
                取消
              </Button>
            )}
            <Button
              color="danger"
              onPress={handleBatchDelete}
              isLoading={batch.isRunning}
              isDisabled={batch.isRunning}
            >
              {batch.progress
                ? `删除中 ${batch.progress.sent} / ${batch.progress.total}`
                : '删除'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  )
}
