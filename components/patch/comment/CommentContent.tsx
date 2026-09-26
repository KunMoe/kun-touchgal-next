'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@heroui/button'
import { ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react'
import { createRoot, type Root } from 'react-dom/client'
import { KunExternalLink } from '~/components/kun/external-link/ExternalLink'
import { sanitizeUserHref } from '~/utils/safeUrl'
import type { PatchComment } from '~/types/api/patch'

interface Props {
  comment: PatchComment
}

const COMMENT_IMAGE_MAX_HEIGHT_REM = 24
const DEFAULT_LINE_HEIGHT_PX = 28
const DEFAULT_COLLAPSED_MAX_HEIGHT =
  COMMENT_IMAGE_MAX_HEIGHT_REM * 16 + DEFAULT_LINE_HEIGHT_PX

export const CommentContent = ({ comment }: Props) => {
  const contentRef = useRef<HTMLDivElement>(null)
  const previousContentRef = useRef(comment.content)
  const [sanitizedContent, setSanitizedContent] = useState(comment.content)
  const [collapsedMaxHeight, setCollapsedMaxHeight] = useState(
    DEFAULT_COLLAPSED_MAX_HEIGHT
  )
  const [isExpanded, setIsExpanded] = useState(false)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [isSpoilerRevealed, setIsSpoilerRevealed] = useState(false)

  useEffect(() => {
    if (previousContentRef.current === comment.content) {
      return
    }

    previousContentRef.current = comment.content
    setSanitizedContent(comment.content)
    setIsExpanded(false)
  }, [comment.content])

  useEffect(() => {
    setIsSpoilerRevealed(false)
  }, [comment.id, comment.isSpoiler])

  useEffect(() => {
    if (!contentRef.current) {
      return
    }

    const linkMounts: {
      element: Element
      root: HTMLDivElement
      linkRoot: Root
    }[] = []
    const externalLinkElements = contentRef.current.querySelectorAll(
      '[data-kun-external-link]'
    )
    externalLinkElements.forEach((element) => {
      const text = element.getAttribute('data-text')
      const href = element.getAttribute('data-href')
      const safeHref = href ? sanitizeUserHref(href) : null
      if (!text || !safeHref) {
        return
      }
      const root = document.createElement('div')
      root.className = element.className
      element.replaceWith(root)
      const linkRoot = createRoot(root)
      linkMounts.push({ element, root, linkRoot })
      linkRoot.render(<KunExternalLink link={safeHref}>{text}</KunExternalLink>)
    })

    return () => {
      // 放回占位 <a>: DOM 未重建时 effect 重跑 (StrictMode 挂载双调用、仅切换剧透标记)
      // 要能再次找到它, 否则链接被卸载后只剩空 div
      linkMounts.forEach(({ element, root }) => root.replaceWith(element))
      window.setTimeout(() => {
        linkMounts.forEach(({ linkRoot }) => linkRoot.unmount())
      }, 0)
    }
  }, [sanitizedContent, isSpoilerRevealed])

  useLayoutEffect(() => {
    if (!contentRef.current) {
      return
    }

    const element = contentRef.current
    const rootFontSize =
      Number.parseFloat(
        window.getComputedStyle(document.documentElement).fontSize
      ) || 16
    const lineHeight =
      Number.parseFloat(window.getComputedStyle(element).lineHeight) ||
      DEFAULT_LINE_HEIGHT_PX
    const nextCollapsedMaxHeight =
      COMMENT_IMAGE_MAX_HEIGHT_REM * rootFontSize + lineHeight

    setCollapsedMaxHeight(nextCollapsedMaxHeight)

    const updateOverflowState = () => {
      setIsOverflowing(element.scrollHeight > nextCollapsedMaxHeight + 8)
    }

    const frameId = window.requestAnimationFrame(updateOverflowState)
    const images = Array.from(element.querySelectorAll('img'))
    images.forEach((img) => {
      img.addEventListener('load', updateOverflowState)
    })

    const mutationObserver = new MutationObserver(updateOverflowState)
    mutationObserver.observe(element, { childList: true, subtree: true })

    return () => {
      window.cancelAnimationFrame(frameId)
      images.forEach((img) => {
        img.removeEventListener('load', updateOverflowState)
      })
      mutationObserver.disconnect()
    }
  }, [sanitizedContent, isSpoilerRevealed])

  useEffect(() => {
    if (!isOverflowing) {
      setIsExpanded(false)
    }
  }, [isOverflowing])

  const isHidden = comment.isSpoiler && !isSpoilerRevealed

  if (isHidden) {
    return (
      <div
        className="relative p-2 rounded-lg bg-warning-50 dark:bg-warning-100/10 border border-warning-200 dark:border-warning-500/20 cursor-pointer hover:bg-warning-100 dark:hover:bg-warning-100/20 transition-colors"
        onClick={() => setIsSpoilerRevealed(true)}
      >
        <div className="flex items-center gap-1.5 text-warning-600 dark:text-warning-500">
          <EyeOff className="size-3.5" />
          <span className="text-xs font-medium">此评论包含剧透 — 点击显示</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {comment.isSpoiler && (
        <div
          className="relative p-2 rounded-lg bg-warning-50 dark:bg-warning-100/10 border border-warning-200 dark:border-warning-500/20 cursor-pointer hover:bg-warning-100 dark:hover:bg-warning-100/20 transition-colors"
          onClick={() => setIsSpoilerRevealed(false)}
        >
          <div className="flex items-center gap-1.5 text-warning-600 dark:text-warning-500">
            <Eye className="size-3.5" />
            <span className="text-xs font-medium">剧透评论 — 点击隐藏</span>
          </div>
        </div>
      )}

      <div className="relative">
        <div
          ref={contentRef}
          className={`kun-prose kun-prose-compact kun-comment-content max-w-none overflow-hidden transition-all duration-300 ease-in-out`}
          style={
            isExpanded ? undefined : { maxHeight: `${collapsedMaxHeight}px` }
          }
          dangerouslySetInnerHTML={{ __html: sanitizedContent }}
        />

        {isOverflowing && !isExpanded && (
          <div className="pointer-events-none absolute bottom-0 left-0 h-12 w-full bg-gradient-to-t from-content1 to-transparent" />
        )}
      </div>

      {isOverflowing && (
        <Button
          variant="light"
          color="primary"
          className="mt-1 px-2 py-1 text-sm"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          {isExpanded ? (
            <>
              <ChevronUp className="mr-1 size-4" />
              收起评论
            </>
          ) : (
            <>
              <ChevronDown className="mr-1 size-4" />
              展开评论
            </>
          )}
        </Button>
      )}
    </div>
  )
}
