'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, User } from '@heroui/react'
import { ChevronDown, ChevronUp, Download } from 'lucide-react'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { KunResourceDownloadCard } from './KunDownloadCard'
import Link from 'next/link'
import type { KunMoyuPatchResource } from '~/types/api/kun/moyu-moe'

interface Props {
  resource: KunMoyuPatchResource
}

const COLLAPSED_HEIGHT_PX = 96

export const KunResourceDownload = ({ resource }: Props) => {
  const [showLinks, setShowLinks] = useState(false)
  const [note, setNote] = useState('')

  const [isNoteExpanded, setIsNoteExpanded] = useState(false)
  const [isNoteOverflowing, setIsNoteOverflowing] = useState(false)
  const noteContentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const getResourceNoteHtml = async () => {
      // DOMPurify 只有「补丁」分区的鲲补丁资源用得到, 与 markdownToHtml 一并按需加载;
      // 备注来自第三方, 净化不能省
      const [{ markdownToHtml }, { default: DOMPurify }] = await Promise.all([
        import('./markdownToHtml'),
        import('isomorphic-dompurify')
      ])
      const html = await markdownToHtml(resource.note)
      if (cancelled) {
        return
      }
      setNote(DOMPurify.sanitize(html))
    }
    getResourceNoteHtml()
    return () => {
      cancelled = true
    }
  }, [resource.note])

  useLayoutEffect(() => {
    const element = noteContentRef.current
    if (element) {
      if (element.scrollHeight > COLLAPSED_HEIGHT_PX) {
        setIsNoteOverflowing(true)
      } else {
        setIsNoteOverflowing(false)
      }
    }
  }, [note])

  return (
    <div className="space-y-3">
      {resource.name && !resource.note && (
        <p className="mt-2 whitespace-pre-wrap">{resource.name}</p>
      )}

      {resource.note ? (
        <div className="w-full">
          <div className="flex flex-col gap-1">
            <h3 className="font-medium">
              {resource.name ? resource.name : '资源备注'}
            </h3>
            <p className="text-sm text-default-500">
              该补丁资源最后更新于 <KunTimeAgo date={resource.updated_at} />
            </p>
          </div>

          <div className="relative mt-2">
            <div
              ref={noteContentRef}
              className={`kun-prose max-w-none overflow-hidden transition-all duration-300 ease-in-out`}
              style={{
                maxHeight: isNoteExpanded ? '' : `${COLLAPSED_HEIGHT_PX}px`
              }}
            >
              <div
                dangerouslySetInnerHTML={{
                  __html: note
                }}
              />
            </div>

            {isNoteOverflowing && !isNoteExpanded && (
              <div className="absolute bottom-0 left-0 w-full h-12 bg-gradient-to-t from-content1 to-transparent" />
            )}
          </div>

          {isNoteOverflowing && (
            <Button
              variant="light"
              color="primary"
              className="px-2 py-1 mt-1 text-sm"
              onPress={() => setIsNoteExpanded(!isNoteExpanded)}
            >
              {isNoteExpanded ? (
                <>
                  <ChevronUp className="mr-1 size-4" />
                  收起备注
                </>
              ) : (
                <>
                  <ChevronDown className="mr-1 size-4" />
                  展开全部备注
                </>
              )}
            </Button>
          )}
        </div>
      ) : (
        <p>{resource.name}</p>
      )}

      <div className="flex justify-between">
        <Link target="_blank" href={resource.publisher.web_url}>
          <User
            name={resource.publisher.name}
            description={resource.publisher.name}
            avatarProps={{
              showFallback: true,
              src: resource.publisher.avatar_url,
              name: resource.publisher.name.charAt(0).toUpperCase()
            }}
          />
        </Link>

        <div className="flex gap-2">
          <Button
            color="primary"
            variant="flat"
            isIconOnly
            aria-label={`下载 Galgame 补丁资源`}
            onPress={() => setShowLinks((v) => !v)}
          >
            <Download className="size-4" />
          </Button>
        </div>
      </div>

      {showLinks && <KunResourceDownloadCard resource={resource} />}
    </div>
  )
}
