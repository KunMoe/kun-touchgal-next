'use client'

import { Button } from '@heroui/button'
import { Pagination } from '@heroui/pagination'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { resolveReplyView, type ReplyViewState } from './replyPagination'

interface Props {
  // 回复列表容器的 id: 折叠按钮的 aria-controls 指向它, 翻页 / 收起后也靠它把列表顶拉回视口
  listId: string
  // 分页导航地标的名称: 同页可同时展开多楼, 带上楼主名以互相区分
  label: string
  replyCount: number
  view: ReplyViewState | undefined
  onChange: (view: ReplyViewState) => void
}

// 翻页 / 收起会换掉或缩短列表内容: 列表顶若已滚出视口 (含被吸顶导航遮住的那一段) 就拉回来,
// 否则读者会停在后面不相干的评论上。阈值取列表自身的 scroll-margin-top, 与对齐位置同源
const scrollListTopIntoView = (listId: string) => {
  const list = document.getElementById(listId)
  if (!list) {
    return
  }

  const scrollMarginTop =
    Number.parseFloat(window.getComputedStyle(list).scrollMarginTop) || 0
  if (list.getBoundingClientRect().top < scrollMarginTop) {
    list.scrollIntoView({ block: 'start' })
  }
}

export const CommentReplyPager = ({
  listId,
  label,
  replyCount,
  view,
  onChange
}: Props) => {
  const { foldable, expanded, page, pageCount } = resolveReplyView(
    replyCount,
    view
  )
  if (!foldable) {
    return null
  }

  const handleToggle = () => {
    if (!expanded) {
      onChange({ expanded: true, page: 1 })
      return
    }
    onChange({ expanded: false, page: 1 })
    scrollListTopIntoView(listId)
  }

  const handlePageChange = (nextPage: number) => {
    onChange({ expanded: true, page: nextPage })
    scrollListTopIntoView(listId)
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pl-4">
      {/* 展开与收起共用同一个按钮: 切换后焦点留在原处, 不随按钮卸载丢到 body */}
      <Button
        size="sm"
        variant="light"
        color="primary"
        aria-expanded={expanded}
        aria-controls={listId}
        startContent={
          expanded ? (
            <ChevronUp className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )
        }
        onPress={handleToggle}
      >
        {expanded ? '收起回复' : `共 ${replyCount} 条回复，点击展开`}
      </Button>

      {expanded && pageCount > 1 && (
        <Pagination
          aria-label={label}
          size="sm"
          isCompact
          showControls
          // 页数再多也只占 7 格, 窄屏上不会溢出评论卡片
          siblings={0}
          total={pageCount}
          page={page}
          onChange={handlePageChange}
        />
      )}
    </div>
  )
}
