'use client'

import { useState } from 'react'
import { ChevronDown, ListTree } from 'lucide-react'
import { cn } from '~/utils/cn'
import type { TOCItem } from '~/lib/mdx/types'

interface MobileTOCProps {
  headings: TOCItem[]
}

export const KunMobileTOC = ({ headings }: MobileTOCProps) => {
  const [open, setOpen] = useState(false)

  if (headings.length === 0) {
    return null
  }

  const minHeadingLevel = headings.reduce(
    (min, heading) => Math.min(min, heading.level),
    6
  )

  return (
    <nav
      aria-label="本页面索引"
      className="rounded-[22px] border border-default-200/60 bg-background p-4 shadow-[0_12px_32px_rgba(15,23,42,0.05)] lg:hidden dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-sm font-semibold text-foreground"
      >
        <span className="flex items-center gap-2">
          <ListTree className="size-4 text-primary-500" aria-hidden="true" />
          本页面索引
          <span className="text-xs font-normal text-default-400">
            {headings.length} 个章节
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 text-default-400 transition-transform duration-200 motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <ul className="mt-3 space-y-1 border-t border-default-200/60 pt-3">
          {headings.map((heading) => {
            const depth = Math.min(
              Math.max(heading.level - minHeadingLevel, 0),
              2
            )

            return (
              <li
                key={heading.id}
                style={{ marginLeft: `${depth * 0.875}rem` }}
              >
                <a
                  href={`#${heading.id}`}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'block rounded-lg px-2 py-1.5 leading-5 line-clamp-2 transition-colors duration-200 hover:bg-primary-500/5 hover:text-primary-500 motion-reduce:transition-none',
                    depth === 0
                      ? 'text-sm font-semibold text-default-700'
                      : depth === 1
                        ? 'text-sm font-medium text-default-500'
                        : 'text-xs text-default-400'
                  )}
                >
                  {heading.text}
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </nav>
  )
}
