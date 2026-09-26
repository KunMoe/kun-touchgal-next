'use client'

import { useEffect, useState } from 'react'
import { ListTree } from 'lucide-react'
import { cn } from '~/utils/cn'
import { usePrioritizedWheelScroll } from './usePrioritizedWheelScroll'
import type { TOCItem } from '~/lib/mdx/types'

interface TableOfContentsProps {
  headings: TOCItem[]
}

const scrollToHeading = (id: string) => {
  const headingElement = document.getElementById(id)

  if (!headingElement) {
    return
  }

  const prefersReducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches

  headingElement.scrollIntoView({
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
    block: 'start'
  })
}

export const TableOfContents = ({ headings }: TableOfContentsProps) => {
  const [activeId, setActiveId] = useState('')
  const { containerRef: tableOfContentsRef, scrollContainerRef } =
    usePrioritizedWheelScroll<HTMLElement, HTMLUListElement>()

  useEffect(() => {
    if (headings.length === 0) {
      return
    }

    // 激活规则: 视口顶部 20% 激活带内最后一个标题; 两标题同屏/上滚时
    // IntersectionObserver 可能无命中, 此时回退为「当前滚动位置之前的最后一个标题」
    const visibleIds = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            visibleIds.add(entry.target.id)
          } else {
            visibleIds.delete(entry.target.id)
          }
        })

        if (visibleIds.size > 0) {
          const lastVisible = headings
            .filter((heading) => visibleIds.has(heading.id))
            .at(-1)
          if (lastVisible) {
            setActiveId(lastVisible.id)
            return
          }
        }

        const fallback = headings
          .filter((heading) => {
            const element = document.getElementById(heading.id)
            return element && element.getBoundingClientRect().top <= 96
          })
          .at(-1)
        setActiveId((fallback ?? headings[0]).id)
      },
      { rootMargin: '0px 0px -80% 0px' }
    )

    headings.forEach((heading) => {
      const element = document.getElementById(heading.id)

      if (element) {
        observer.observe(element)
      }
    })

    return () => observer.disconnect()
  }, [headings])

  const minHeadingLevel = headings.reduce(
    (min, heading) => Math.min(min, heading.level),
    6
  )

  return (
    <nav
      ref={tableOfContentsRef}
      aria-label="本页面索引"
      className="sticky top-20 hidden h-[calc(100dvh-6rem)] w-64 shrink-0 self-start lg:block"
    >
      <div className="flex h-full flex-col overflow-hidden rounded-[22px] border border-default-200/60 bg-background p-4 shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <ListTree className="size-4 text-primary-500" aria-hidden="true" />
          <span>本页面索引</span>
        </h2>
        {headings.length > 0 ? (
          <ul
            ref={scrollContainerRef}
            className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 scrollbar-hide"
          >
            {headings.map((heading) => {
              const isActive = activeId === heading.id
              const depth = Math.min(
                Math.max(heading.level - minHeadingLevel, 0),
                2
              )
              const isTopLevel = depth === 0
              const isSecondLevel = depth === 1

              return (
                <li
                  key={heading.id}
                  style={{ marginLeft: `${depth * 0.875}rem` }}
                >
                  <a
                    href={`#${heading.id}`}
                    onClick={(event) => {
                      event.preventDefault()
                      scrollToHeading(heading.id)
                    }}
                    aria-current={isActive ? 'location' : undefined}
                    className={cn(
                      'group relative flex min-h-8 items-start gap-2 rounded-xl py-1.5 pl-3 pr-2 transition-colors duration-200 hover:bg-primary-500/5 hover:text-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 motion-reduce:transition-none',
                      isTopLevel
                        ? 'text-sm font-semibold'
                        : isSecondLevel
                          ? 'text-sm font-medium'
                          : 'text-xs font-normal',
                      isActive
                        ? 'bg-primary-500/10 text-primary-500'
                        : isTopLevel
                          ? 'text-default-700'
                          : isSecondLevel
                            ? 'text-default-500'
                            : 'text-default-400'
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-1.5 shrink-0 rounded-full transition-colors duration-200 group-hover:bg-primary-300 motion-reduce:transition-none',
                        isTopLevel
                          ? 'size-2'
                          : isSecondLevel
                            ? 'mt-2 size-1.5'
                            : 'mt-2 size-1',
                        isActive
                          ? 'bg-primary-500'
                          : isTopLevel
                            ? 'bg-default-400'
                            : 'bg-default-300'
                      )}
                    />
                    <span className="min-w-0 flex-1 leading-5 line-clamp-2">
                      {heading.text}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="rounded-2xl bg-default-100/70 p-3 text-sm text-default-500">
            此页面暂无标题索引
          </p>
        )}
      </div>
    </nav>
  )
}
