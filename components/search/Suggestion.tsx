'use client'

import { useEffect, useState } from 'react'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { useKunKeyedQuery } from '~/hooks/useKunKeyedQuery'
import { Chip } from '@heroui/react'
import { House, Key, Tag } from 'lucide-react'
import { KunLoading } from '~/components/kun/Loading'
import { cn } from '~/utils/cn'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { SearchSuggestionType } from '~/types/api/search'

export interface SearchSuggestionNav {
  move: (delta: number) => void
  activate: (mode: SearchSuggestionType['mode']) => boolean
}

export const SEARCH_SUGGESTION_LISTBOX_ID = 'search-suggestion-listbox'
export const SEARCH_SUGGESTION_HINT_ID = 'search-suggestion-hint'
export const getSearchSuggestionOptionId = (index: number) =>
  `search-suggestion-option-${index}`

const SUGGESTION_DISPLAY_LIMIT = 8

type FlatOption =
  | { kind: 'keyword' }
  | { kind: 'suggestion'; suggestion: SearchSuggestionType }
  | { kind: 'more' }

interface ExcludeButtonProps {
  onExclude: () => void
}

const ExcludeButton = ({ onExclude }: ExcludeButtonProps) => (
  <button
    type="button"
    tabIndex={-1}
    className="h-8 shrink-0 rounded-lg px-3 text-sm text-default-500 transition-colors hover:bg-default-200 hover:text-default-700"
    onClick={(event) => {
      event.stopPropagation()
      onExclude()
    }}
  >
    排除
  </button>
)

interface Props {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  debouncedQuery: string
  setQuery: Dispatch<SetStateAction<string>>
  setSelectedSuggestions: Dispatch<SetStateAction<SearchSuggestionType[]>>
  activeIndex: number
  setActiveIndex: Dispatch<SetStateAction<number>>
  navRef: RefObject<SearchSuggestionNav | null>
}

export const SearchSuggestion = ({
  inputRef,
  query,
  debouncedQuery,
  setQuery,
  setSelectedSuggestions,
  activeIndex,
  setActiveIndex,
  navRef
}: Props) => {
  const [showAll, setShowAll] = useState(false)
  const queryArraySplitByBlank = query
    .trim()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)

  // 键是防抖后的词组以单个空格相连: 只差空白的输入不重取, 旧键的慢应答不会盖掉新键 (P29-03)
  const suggestionKey = debouncedQuery
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .join(' ')
  const suggestionQuery = useKunKeyedQuery({
    key: suggestionKey,
    enabled: suggestionKey !== '',
    fetch: (key) =>
      kunFetchPost<KunResponse<SearchSuggestionType[]>>('/search/tag', {
        query: key.split(' ')
      }),
    onFailure: (message) => kunErrorHandler(message, () => {})
  })
  const isPending = suggestionQuery.status === 'loading'
  // 只显示属于当前键的建议: 键为空、取数中或当前键失败时都不拿上一个键的结果充数
  const suggestions =
    !isPending && suggestionQuery.dataKey === suggestionKey
      ? (suggestionQuery.data ?? [])
      : []

  useEffect(() => {
    setShowAll(false)
  }, [query])

  useEffect(() => {
    setActiveIndex(-1)
  }, [query, setActiveIndex])

  useEffect(() => {
    if (activeIndex < 0) {
      return
    }
    document
      .getElementById(getSearchSuggestionOptionId(activeIndex))
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleClickSuggestion = (suggestions: SearchSuggestionType[]) => {
    setQuery('')
    setSelectedSuggestions((prev) => {
      const keysToRemove = new Set(
        suggestions.map((s) => `${s.type}:${s.name}`)
      )
      const filtered = prev.filter(
        (item) => !keysToRemove.has(`${item.type}:${item.name}`)
      )
      return [...filtered, ...suggestions]
    })
    inputRef.current?.focus()
  }

  const handleSelectMultiQueryKeywords = (
    mode: SearchSuggestionType['mode']
  ) => {
    if (!queryArraySplitByBlank.length) {
      return
    }

    const suggestions: SearchSuggestionType[] = queryArraySplitByBlank.map(
      (q) => ({
        type: 'keyword',
        mode,
        name: q
      })
    )
    handleClickSuggestion(suggestions)
  }

  const hasKeywordRow = queryArraySplitByBlank.length > 0
  const visibleSuggestions = isPending
    ? []
    : showAll
      ? suggestions
      : suggestions.slice(0, SUGGESTION_DISPLAY_LIMIT)
  const hiddenCount = isPending
    ? 0
    : suggestions.length - visibleSuggestions.length

  const flatOptions: FlatOption[] = [
    ...(hasKeywordRow ? [{ kind: 'keyword' } as const] : []),
    ...visibleSuggestions.map(
      (suggestion) => ({ kind: 'suggestion', suggestion }) as const
    ),
    ...(hiddenCount > 0 ? [{ kind: 'more' } as const] : [])
  ]
  const optionCount = flatOptions.length

  // 列表收缩(如 fetch 进行中折叠)时仅回收越界高亮;
  // 内容更新但位置仍有效的高亮(如建议到达前选中的关键词行)保留
  useEffect(() => {
    setActiveIndex((prev) => (prev >= optionCount ? -1 : prev))
  }, [optionCount, setActiveIndex])

  useEffect(() => {
    navRef.current = {
      move: (delta) => {
        if (!optionCount) {
          return
        }
        setActiveIndex((prev) => {
          const next = prev + delta
          if (next < 0) {
            return optionCount - 1
          }
          if (next >= optionCount) {
            return 0
          }
          return next
        })
      },
      activate: (mode) => {
        const option = flatOptions[activeIndex]
        if (!option) {
          return false
        }
        if (option.kind === 'more') {
          setShowAll(true)
          return true
        }
        if (option.kind === 'keyword') {
          handleSelectMultiQueryKeywords(mode)
          return true
        }
        handleClickSuggestion([{ ...option.suggestion, mode }])
        return true
      }
    }
  })

  useEffect(() => {
    return () => {
      navRef.current = null
    }
  }, [navRef])

  const renderOption = (option: FlatOption, index: number) => {
    const isActive = activeIndex === index
    const optionId = getSearchSuggestionOptionId(index)

    if (option.kind === 'more') {
      return (
        <div
          key="more"
          id={optionId}
          role="option"
          aria-selected={isActive}
          className={cn(
            'cursor-pointer rounded-2xl p-2 text-center text-sm text-primary-500',
            isActive ? 'bg-default-100' : 'hover:bg-default-100'
          )}
          onClick={() => setShowAll(true)}
        >
          查看全部 {suggestions.length} 条建议
        </div>
      )
    }

    const rowClassName = cn(
      'flex cursor-pointer items-center justify-between gap-2 rounded-2xl p-1',
      isActive ? 'bg-default-100' : 'hover:bg-default-100'
    )

    if (option.kind === 'keyword') {
      return (
        <div
          key="keyword"
          id={optionId}
          role="option"
          aria-selected={isActive}
          className={rowClassName}
          onClick={() => handleSelectMultiQueryKeywords('include')}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Chip
              color="default"
              variant="flat"
              startContent={<Key className="w-4 h-4" />}
            >
              关键词
            </Chip>
            {queryArraySplitByBlank.map((q, keywordIndex) => (
              <Chip key={keywordIndex} color="default" variant="flat">
                {q}
              </Chip>
            ))}
          </div>
          <ExcludeButton
            onExclude={() => handleSelectMultiQueryKeywords('exclude')}
          />
        </div>
      )
    }

    const { suggestion } = option
    return (
      <div
        key={`${suggestion.type}:${suggestion.name}`}
        id={optionId}
        role="option"
        aria-selected={isActive}
        className={rowClassName}
        onClick={() =>
          handleClickSuggestion([{ ...suggestion, mode: 'include' }])
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {suggestion.type === 'tag' && (
            <Chip
              color="secondary"
              variant="flat"
              startContent={<Tag className="w-4 h-4" />}
            >
              标签
            </Chip>
          )}
          {suggestion.type === 'company' && (
            <Chip
              color="warning"
              variant="flat"
              startContent={<House className="w-4 h-4" />}
            >
              会社
            </Chip>
          )}
          <span className="truncate">{suggestion.name}</span>
        </div>
        <ExcludeButton
          onExclude={() =>
            handleClickSuggestion([{ ...suggestion, mode: 'exclude' }])
          }
        />
      </div>
    )
  }

  return (
    <div
      className="absolute z-50 w-full p-3 space-y-2 overflow-auto border shadow-lg max-h-96 rounded-2xl bg-content1 border-default-200"
      onMouseDown={(event) => event.preventDefault()}
    >
      <p id={SEARCH_SUGGESTION_HINT_ID} className="text-sm text-default-500">
        回车或点击添加为包含条件 · Shift + 回车排除 · ↑↓ 选择 · Esc 关闭
      </p>

      <div
        id={SEARCH_SUGGESTION_LISTBOX_ID}
        role="listbox"
        aria-label="搜索建议"
        className="space-y-2"
      >
        {flatOptions.map(renderOption)}
        {isPending && <KunLoading hint="正在获取标签..." />}
      </div>
    </div>
  )
}
