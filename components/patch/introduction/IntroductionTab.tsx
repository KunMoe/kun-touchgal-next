'use client'

import { memo, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Card, CardBody } from '@heroui/card'
import dynamic from 'next/dynamic'
import { Info } from './Info'
import { PatchTag } from './Tag'
import { PatchCompany } from './Company'
import { SAFE_MEDIA_PROTOCOLS, sanitizeUserUrl } from '~/utils/safeUrl'
import { useKunExternalLinkNavigation } from '~/components/kun/external-link/useKunExternalLinkNavigation'
import type { PatchIntroduction } from '~/types/api/patch'

const KunPlyr = dynamic(
  () =>
    import('~/components/kun/milkdown/plugins/components/video/Plyr').then(
      (mod) => mod.KunPlyr
    ),
  { ssr: false }
)

const getClosestVideoPlayer = (target: EventTarget | null) => {
  if (!(target instanceof Element)) {
    return null
  }

  const element = target.closest('[data-video-player]')
  return element instanceof HTMLElement ? element : null
}

const scheduleRootUnmount = (root: Root) => {
  window.setTimeout(() => {
    root.unmount()
  }, 0)
}

const VideoLoadingPlaceholder = () => (
  <>
    <div className="absolute inset-0 bg-black" />
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#00b3ff] shadow-lg">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      </div>
    </div>
  </>
)

const LazyKunPlyr = ({ src, autoPlay }: { src: string; autoPlay: boolean }) => {
  const [isReady, setIsReady] = useState(false)

  return (
    <div className="relative w-full aspect-video overflow-hidden rounded-xl bg-black">
      {!isReady && <VideoLoadingPlaceholder />}
      <div
        className={`absolute inset-0 [&_.plyr]:h-full [&_.plyr]:w-full [&_.plyr__video-wrapper]:h-full [&_video]:h-full [&_video]:w-full [&_video]:object-contain [&_video]:object-center ${
          isReady ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <KunPlyr
          src={src}
          className="h-full w-full object-contain object-center"
          autoPlay={autoPlay}
          onReady={() => setIsReady(true)}
        />
      </div>
    </div>
  )
}

interface Props {
  intro: PatchIntroduction
  patchId: number
  uid?: number
}

export const IntroductionTab = memo(function IntroductionTab({
  intro,
  patchId,
  uid
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null)

  useKunExternalLinkNavigation(contentRef, intro.introduction)

  useEffect(() => {
    const content = contentRef.current
    if (!content) {
      return
    }

    const videoRoots = new Map<HTMLElement, Root>()

    const mountVideoPlayer = (element: HTMLElement) => {
      if (
        !content.contains(element) ||
        element.hasAttribute('data-video-loaded')
      ) {
        return
      }

      const src = element.getAttribute('data-src')
      const safeSrc = src ? sanitizeUserUrl(src, SAFE_MEDIA_PROTOCOLS) : null
      if (!safeSrc) {
        return
      }

      const rootElement = document.createElement('div')
      rootElement.className = 'w-full'
      element.setAttribute('data-video-loaded', '')
      element.removeAttribute('role')
      element.removeAttribute('tabindex')
      element.replaceChildren(rootElement)

      const root = createRoot(rootElement)
      videoRoots.set(element, root)
      root.render(<LazyKunPlyr src={safeSrc} autoPlay />)
    }

    const handleVideoClick = (event: MouseEvent) => {
      const element = getClosestVideoPlayer(event.target)
      if (element) {
        mountVideoPlayer(element)
      }
    }

    const handleVideoKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }

      const element = getClosestVideoPlayer(event.target)
      if (!element || element.hasAttribute('data-video-loaded')) {
        return
      }

      event.preventDefault()
      mountVideoPlayer(element)
    }

    content.addEventListener('click', handleVideoClick)
    content.addEventListener('keydown', handleVideoKeyDown)

    return () => {
      content.removeEventListener('click', handleVideoClick)
      content.removeEventListener('keydown', handleVideoKeyDown)
      videoRoots.forEach(scheduleRootUnmount)
      videoRoots.clear()
    }
  }, [intro.introduction])

  return (
    <Card className="p-1 sm:p-8">
      <CardBody className="p-4 space-y-6">
        <div
          ref={contentRef}
          dangerouslySetInnerHTML={{ __html: intro.introduction }}
          className="kun-prose kun-prose-compact max-w-none"
        />

        {/* <div className="mt-4">
          <h3 className="mb-4 text-xl font-medium">游戏制作商</h3>
        </div> */}

        {uid && <PatchTag patchId={patchId} initialTags={intro.tag} />}

        <PatchCompany
          patchId={patchId}
          initialCompanies={intro.company}
          vndbId={intro.vndbId}
          bangumiId={intro.bangumiId}
          steamId={intro.steamId}
          dlsiteCode={intro.dlsiteCode}
        />

        <Info intro={intro} />
      </CardBody>
    </Card>
  )
})
