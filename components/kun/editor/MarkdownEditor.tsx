'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from 'react'
import { Button } from '@heroui/button'
import { Tooltip } from '@heroui/tooltip'
import { useDebounce } from 'use-debounce'
import { kunFetchGet } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { MentionListDropdown } from './MentionListDropdown'
import {
  Bold,
  Italic,
  Strikethrough,
  Heading,
  Link,
  Image,
  Quote,
  Code,
  List,
  ListOrdered,
  Minus,
  Eye,
  PenLine
} from 'lucide-react'
import { cn } from '~/utils/cn'
import { markdownToPreviewHtml } from '~/utils/markdownPreview'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  minHeight?: number
  className?: string
}

interface ToolbarAction {
  icon: typeof Bold
  label: string
  title: string
  prefix: string
  suffix: string
  multiline?: boolean
  placeholder?: string
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  {
    icon: Bold,
    label: 'Bold',
    title: '加粗 (Ctrl+B)',
    prefix: '**',
    suffix: '**'
  },
  {
    icon: Italic,
    label: 'Italic',
    title: '斜体 (Ctrl+I)',
    prefix: '*',
    suffix: '*'
  },
  {
    icon: Strikethrough,
    label: 'Strikethrough',
    title: '删除线',
    prefix: '~~',
    suffix: '~~'
  },
  {
    icon: Heading,
    label: 'Heading',
    title: '标题',
    prefix: '## ',
    suffix: ''
  },
  {
    icon: Link,
    label: 'Link',
    title: '链接 (Ctrl+K)',
    prefix: '[',
    suffix: '](url)',
    placeholder: '链接文字'
  },
  {
    icon: Image,
    label: 'Image',
    title: '图片',
    prefix: '![',
    suffix: '](url)',
    placeholder: '图片描述'
  },
  {
    icon: Quote,
    label: 'Quote',
    title: '引用',
    prefix: '> ',
    suffix: ''
  },
  {
    icon: Code,
    label: 'Code',
    title: '代码块',
    prefix: '```\n',
    suffix: '\n```',
    multiline: true,
    placeholder: '代码'
  },
  {
    icon: List,
    label: 'Unordered List',
    title: '无序列表',
    prefix: '- ',
    suffix: ''
  },
  {
    icon: ListOrdered,
    label: 'Ordered List',
    title: '有序列表',
    prefix: '1. ',
    suffix: ''
  },
  {
    icon: Minus,
    label: 'Horizontal Rule',
    title: '分割线',
    prefix: '\n---\n',
    suffix: '',
    placeholder: ''
  }
]

const MENTION_DROPDOWN_HEIGHT = 320

const getCaretPixelPosition = (
  textarea: HTMLTextAreaElement,
  index: number
) => {
  const computed = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.boxSizing = 'border-box'
  mirror.style.width = `${textarea.clientWidth}px`
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.fontFamily = computed.fontFamily
  mirror.style.fontSize = computed.fontSize
  mirror.style.fontWeight = computed.fontWeight
  mirror.style.letterSpacing = computed.letterSpacing
  mirror.style.lineHeight = computed.lineHeight
  mirror.style.padding = computed.padding
  mirror.textContent = textarea.value.slice(0, index)
  const marker = document.createElement('span')
  marker.textContent = textarea.value.slice(index, index + 1) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const position = {
    top: marker.offsetTop,
    left: marker.offsetLeft,
    lineHeight: parseFloat(computed.lineHeight) || 20
  }
  document.body.removeChild(mirror)
  return position
}

export const KunMarkdownEditor = ({
  value,
  onChange,
  placeholder = '输入 Markdown 内容...',
  minHeight = 200,
  className
}: Props) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [activeTab, setActiveTab] = useState<'write' | 'preview'>('write')
  const [contentHeight, setContentHeight] = useState(minHeight)
  const previewHtml = useMemo(() => markdownToPreviewHtml(value), [value])

  const [mention, setMention] = useState<{
    anchor: number
    query: string
  } | null>(null)
  const [mentionStyle, setMentionStyle] = useState<React.CSSProperties>({})
  const [mentionUsers, setMentionUsers] = useState<KunUser[]>([])
  const [isMentionPending, startMentionTransition] = useTransition()
  const [debouncedMentionQuery] = useDebounce(mention?.query ?? '', 500)
  // Escape 关闭后记住该 @ 的位置, 避免下一次光标变化立即重新打开
  const dismissedAnchorRef = useRef<number | null>(null)
  const positionedAnchorRef = useRef<number | null>(null)

  const closeMention = useCallback(() => {
    setMention(null)
    setMentionUsers((prev) => (prev.length ? [] : prev))
    positionedAnchorRef.current = null
  }, [])

  const detectMention = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    const textBeforeCaret = textarea.value.slice(0, textarea.selectionEnd)
    const lineStart = textBeforeCaret.lastIndexOf('\n') + 1
    const currentLine = textBeforeCaret.slice(lineStart)
    const lastAtIndex = currentLine.lastIndexOf('@')
    const query = currentLine.slice(lastAtIndex + 1)

    // 与旧编辑器一致: @ 与光标之间出现空白字符即退出提及模式
    if (lastAtIndex < 0 || /\s/.test(query)) {
      dismissedAnchorRef.current = null
      closeMention()
      return
    }

    const anchor = lineStart + lastAtIndex
    if (dismissedAnchorRef.current === anchor) {
      return
    }
    dismissedAnchorRef.current = null
    setMention((prev) =>
      prev && prev.anchor === anchor && prev.query === query
        ? prev
        : { anchor, query }
    )

    // @ 位置不变时下拉位置也不变, 跳过 mirror 布局计算
    if (positionedAnchorRef.current === anchor) {
      return
    }
    positionedAnchorRef.current = anchor

    const caretPos = getCaretPixelPosition(textarea, anchor)
    const rect = textarea.getBoundingClientRect()
    const anchorTop = rect.top + caretPos.top - textarea.scrollTop
    const left = Math.max(
      8,
      Math.min(rect.left + caretPos.left, window.innerWidth - 272)
    )
    const spaceBelow = window.innerHeight - (anchorTop + caretPos.lineHeight)
    if (
      spaceBelow < MENTION_DROPDOWN_HEIGHT &&
      anchorTop > window.innerHeight / 2
    ) {
      setMentionStyle({ bottom: window.innerHeight - anchorTop + 4, left })
    } else {
      setMentionStyle({ top: anchorTop + caretPos.lineHeight, left })
    }
  }, [closeMention])

  useEffect(() => {
    // 服务端 schema 限制 query 最长 20, 超长必然失败, 不发请求
    if (!debouncedMentionQuery.length || debouncedMentionQuery.length > 20) {
      setMentionUsers((prev) => (prev.length ? [] : prev))
      return
    }

    let cancelled = false
    startMentionTransition(async () => {
      try {
        const response = await kunFetchGet<KunResponse<KunUser[]>>(
          '/user/mention/search',
          { query: debouncedMentionQuery }
        )
        if (!cancelled) {
          kunErrorHandler(response, setMentionUsers)
        }
      } catch {
        // 输入过程中的自动搜索, 网络错误静默即可
      }
    })
    return () => {
      cancelled = true
    }
  }, [debouncedMentionQuery])

  const handleMentionSelect = useCallback(
    (user: KunUser) => {
      const textarea = textareaRef.current
      if (!textarea || !mention) return

      const end = mention.anchor + 1 + mention.query.length
      const inserted = `[@${user.name}](/user/${user.id}/comment) `
      const newText =
        textarea.value.slice(0, mention.anchor) +
        inserted +
        textarea.value.slice(end)

      onChange(newText)
      closeMention()

      requestAnimationFrame(() => {
        textarea.focus()
        const cursor = mention.anchor + inserted.length
        textarea.setSelectionRange(cursor, cursor)
      })
    },
    [mention, onChange, closeMention]
  )

  const insertFormatting = useCallback(
    (action: ToolbarAction) => {
      const textarea = textareaRef.current
      if (!textarea) return

      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selectedText = value.substring(start, end)
      const hasSelection = start !== end

      let newText: string
      let cursorOffset: number

      if (hasSelection) {
        newText =
          value.substring(0, start) +
          action.prefix +
          selectedText +
          action.suffix +
          value.substring(end)
        cursorOffset =
          start +
          action.prefix.length +
          selectedText.length +
          action.suffix.length
      } else {
        const placeholder = action.placeholder || action.label
        newText =
          value.substring(0, start) +
          action.prefix +
          placeholder +
          action.suffix +
          value.substring(end)
        cursorOffset =
          start +
          action.prefix.length +
          placeholder.length +
          (action.suffix ? 0 : 0)
      }

      onChange(newText)

      requestAnimationFrame(() => {
        textarea.focus()
        if (hasSelection) {
          textarea.setSelectionRange(cursorOffset, cursorOffset)
        } else {
          const selStart = start + action.prefix.length
          const selEnd = selStart + (action.placeholder || action.label).length
          textarea.setSelectionRange(selStart, selEnd)
        }
      })
    },
    [value, onChange]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mention && e.key === 'Escape') {
        e.preventDefault()
        dismissedAnchorRef.current = mention.anchor
        closeMention()
        return
      }

      const isMod = e.metaKey || e.ctrlKey

      if (isMod && e.key === 'b') {
        e.preventDefault()
        insertFormatting(TOOLBAR_ACTIONS[0])
      } else if (isMod && e.key === 'i') {
        e.preventDefault()
        insertFormatting(TOOLBAR_ACTIONS[1])
      } else if (isMod && e.key === 'k') {
        e.preventDefault()
        insertFormatting(TOOLBAR_ACTIONS[4])
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        const textarea = textareaRef.current
        if (!textarea) return
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const newText = value.substring(0, start) + '  ' + value.substring(end)
        onChange(newText)
        requestAnimationFrame(() => {
          textarea.focus()
          textarea.setSelectionRange(start + 2, start + 2)
        })
      }
    },
    [value, onChange, insertFormatting, mention, closeMention]
  )

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const newHeight = Math.max(minHeight, textarea.scrollHeight)
    textarea.style.height = `${newHeight}px`
    setContentHeight(newHeight)
  }, [minHeight])

  useEffect(() => {
    autoResize()
  }, [value, autoResize])

  const wordCount = useMemo(() => {
    const cleaned = value.replace(/\s/g, '')
    return cleaned.length
  }, [value])

  return (
    <div
      className={cn(
        'kun-editor border-default-200 overflow-hidden rounded-xl border bg-content1 transition-colors',
        'focus-within:border-primary-300 focus-within:ring-2 focus-within:ring-primary-200/50',
        className
      )}
    >
      {/* Toolbar */}
      <div className="border-default-200 bg-default-50 flex items-center gap-0.5 border-b px-2 py-1.5">
        {TOOLBAR_ACTIONS.map((action) => (
          <Tooltip
            key={action.label}
            content={action.title}
            showArrow
            closeDelay={0}
            size="sm"
          >
            <Button
              variant="light"
              size="sm"
              isIconOnly
              className="text-default-500 hover:text-default-700 hover:bg-default-200 h-8 w-8 min-w-0 rounded-lg transition-colors"
              onPress={() => insertFormatting(action)}
            >
              <action.icon className="size-4" />
            </Button>
          </Tooltip>
        ))}
      </div>

      {/* Tab switcher */}
      <div className="border-default-200 flex items-center border-b px-3">
        <button
          type="button"
          onClick={() => setActiveTab('write')}
          className={cn(
            'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            activeTab === 'write'
              ? 'border-primary text-primary'
              : 'border-transparent text-default-500 hover:text-default-700'
          )}
        >
          <PenLine className="size-3.5" />
          编辑
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('preview')}
          className={cn(
            'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            activeTab === 'preview'
              ? 'border-primary text-primary'
              : 'border-transparent text-default-500 hover:text-default-700'
          )}
        >
          <Eye className="size-3.5" />
          预览
        </button>
      </div>

      {/* Content area */}
      <div className="relative">
        {activeTab === 'write' ? (
          <>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onSelect={detectMention}
              onBlur={closeMention}
              placeholder={placeholder}
              className="text-default-800 placeholder:text-default-400 w-full resize-none bg-transparent px-4 py-3 text-sm leading-relaxed outline-none"
              style={{ height: `${contentHeight}px` }}
            />
            {mention && (
              <MentionListDropdown
                isPending={isMentionPending}
                users={mentionUsers}
                style={mentionStyle}
                onSelect={handleMentionSelect}
              />
            )}
          </>
        ) : (
          <div
            className="kun-prose kun-prose-compact overflow-y-auto px-4 py-3 text-sm"
            style={{ height: `${contentHeight}px` }}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}
      </div>

      {/* Footer */}
      <div className="border-default-200 bg-default-50 flex items-center justify-between border-t px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-default-400 text-xs font-medium">Markdown</span>
          <span className="text-default-300 text-xs">·</span>
          <span className="text-default-400 text-xs">Ctrl+B 加粗</span>
        </div>
        <span className="text-default-400 text-xs tabular-nums">
          {wordCount} 字
        </span>
      </div>
    </div>
  )
}
