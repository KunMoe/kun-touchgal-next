'use client'

import { useReducer, useState } from 'react'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { Button } from '@heroui/button'
import { Chip } from '@heroui/chip'
import { Checkbox } from '@heroui/checkbox'
import { ScrollShadow } from '@heroui/scroll-shadow'
import { Link } from '@heroui/link'
import { useDebounce } from 'use-debounce'
import { useRouter } from '@bprogress/next/app'
import toast from 'react-hot-toast'
import { KunLoading } from '~/components/kun/Loading'
import { useKunKeyedQuery } from '~/hooks/useKunKeyedQuery'
import { kunFetchGet, kunFetchPost, kunFetchPut } from '~/utils/kunFetch'
import { parseSearchTerms } from '~/utils/term/parseSearchTerms'
import {
  diffTermDraft,
  emptyTermDraft,
  listForEmptyQuery,
  listForSearch,
  reduceTermDraft,
  type TermItem
} from './draft'
import { PATCH_TERM_KINDS, type PatchTermKind } from './kinds'

// 标签与会社的详情页条目同形 (types/api/tag.ts 与 types/api/company.ts)
export interface PatchTermItem extends TermItem {
  alias: string[]
}

interface Props {
  patchId: number
  kind: PatchTermKind
  // 当前关联列表, 由分区组件持有; 只在打开弹窗时拿来播种草稿
  items: PatchTermItem[]
  // 写请求成功后回传服务端给出的完整关联列表, 由分区组件替换 chips
  onChange: (items: PatchTermItem[]) => void
  // 已关联但不显示的条目 (屏蔽的标签): 留在草稿里, 不显示, 不进差量
  hiddenIds?: readonly number[]
}

// 详情页「更改标签 / 更改所属会社」的唯一弹窗。草稿模型见 draft.ts
export const PatchTermEditor = ({
  patchId,
  kind,
  items,
  onChange,
  hiddenIds = []
}: Props) => {
  const config = PATCH_TERM_KINDS[kind]
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [draft, dispatch] = useReducer(
    reduceTermDraft<PatchTermItem>,
    undefined,
    emptyTermDraft<PatchTermItem>
  )
  const [query, setQuery] = useState('')
  // 回车与搜索按钮立刻提交当前输入, 其余时候等输入停 500ms
  const [debouncedQuery, debounceControl] = useDebounce(query, 500)
  const searchKey = debouncedQuery.trim()
  const [submitting, setSubmitting] = useState(false)
  const router = useRouter()

  const candidates = useKunKeyedQuery({
    key: searchKey,
    enabled: isOpen,
    fetch: async (key): Promise<PatchTermItem[] | string> => {
      if (!key) {
        const response = await kunFetchGet<
          Partial<Record<typeof config.listKey, PatchTermItem[]>>
        >(config.listPath, { page: 1, limit: 100 })
        return typeof response === 'string'
          ? response
          : (response[config.listKey] ?? [])
      }
      // 超过 10 组时返回的错误消息按失败处理 (onFailure 提示), 不发请求
      const terms = parseSearchTerms(key)
      if (typeof terms === 'string') {
        return terms
      }
      if (!terms.length) {
        return []
      }
      return kunFetchPost<PatchTermItem[]>(config.searchPath, { query: terms })
    },
    onFailure: (message) => toast.error(message)
  })
  // 只用属于当前键的数据: 换键的那一帧状态机还停在旧键上, 旧键的结果不能当成新键的显示;
  // 当前键取数失败时也不沿用别的键的结果 (搜索框为空时仍列出已关联的)
  const isFresh = candidates.dataKey === searchKey
  const isLoading =
    candidates.status === 'loading' ||
    (candidates.status === 'ready' && !isFresh)
  const searching = isLoading && searchKey !== ''
  const data = isFresh ? (candidates.data ?? []) : []
  const rows = searchKey
    ? listForSearch(data, hiddenIds)
    : listForEmptyQuery(draft, data, hiddenIds)

  // 草稿只在打开时用当前关联播种, 不随 items 变化重置 (#87: 跟着 items 重置会清空勾选)
  const handleOpen = () => {
    dispatch({ type: 'open', items })
    onOpen()
  }

  const handleSearch = () => {
    debounceControl.flush()
  }

  const handleSubmit = async () => {
    const { add, remove } = diffTermDraft(draft)
    if (!add.length && !remove.length) {
      return
    }

    setSubmitting(true)
    let wrote = false
    // 先删后增, 两步各自是只增或只删的事务; 每一步成功都拿回传的完整列表替换 chips 并校准
    // 草稿, 失败时弹窗保留, 草稿里只剩没落库的差量, 重试只发剩下的部分
    const apply = (response: { items: PatchTermItem[] }) => {
      wrote = true
      onChange(response.items)
      dispatch({ type: 'rebase', items: response.items })
    }
    try {
      if (remove.length) {
        const response = await kunFetchPut<{ items: PatchTermItem[] }>(
          config.mutatePath,
          { patchId, [config.idField]: remove }
        )
        if (typeof response === 'string') {
          toast.error(response)
          return
        }
        apply(response)
      }

      if (add.length) {
        const response = await kunFetchPost<{ items: PatchTermItem[] }>(
          config.mutatePath,
          { patchId, [config.idField]: add }
        )
        if (typeof response === 'string') {
          toast.error(response)
          return
        }
        apply(response)
      }

      toast.success(config.text.success)
      onClose()
    } catch {
      toast.error(config.text.failure)
    } finally {
      // 让 /[id] 的客户端路由缓存换成写入之后的载荷, 后退回到本页时不显示旧关联
      if (wrote) {
        router.refresh()
      }
      setSubmitting(false)
    }
  }

  const Search = config.Search
  const Icon = config.Icon

  return (
    <div>
      <Button
        onPress={handleOpen}
        color="primary"
        variant="bordered"
        startContent={<Icon size={20} />}
      >
        {config.text.button}
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="2xl"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader>{config.text.header}</ModalHeader>
          <ModalBody>
            <Search
              query={query}
              setQuery={setQuery}
              handleSearch={handleSearch}
              searching={searching}
            />
            {!searching && (
              <ScrollShadow className="max-h-[400px]">
                {isLoading ? (
                  <KunLoading hint={config.text.loading} />
                ) : !searchKey && !rows.length && config.text.empty ? (
                  <p className="text-sm text-default-400 text-center py-4">
                    {config.text.empty}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {rows.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-start gap-2 p-2 rounded-lg hover:bg-default-100"
                      >
                        <Checkbox
                          isSelected={draft.desired.has(item.id)}
                          onValueChange={(checked) =>
                            dispatch({ type: 'toggle', item, checked })
                          }
                        >
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{item.name}</span>
                              <Chip size="sm" variant="flat">
                                {item.count} {config.text.countSuffix}
                              </Chip>
                            </div>
                          </div>
                        </Checkbox>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollShadow>
            )}
          </ModalBody>
          <ModalFooter className="flex-col">
            <div className="ml-auto space-x-2">
              <Button variant="flat" onPress={onClose}>
                取消
              </Button>
              <Button
                color="primary"
                onPress={handleSubmit}
                isLoading={submitting}
                isDisabled={submitting}
              >
                确定更改
              </Button>
            </div>
            <div>
              {config.text.footerPrompt}
              <Link color="primary" showAnchorIcon href={config.createHref}>
                {config.text.footerLink}
              </Link>
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  )
}
