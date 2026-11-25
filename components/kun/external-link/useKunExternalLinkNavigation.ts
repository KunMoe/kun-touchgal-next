'use client'

import { useEffect } from 'react'
import { getKunUserSnapshot } from '~/store/userStore'
import {
  getHttpUrlHostname,
  isHostnameExcluded,
  isRedirectableUrl,
  sanitizeUserHref
} from '~/utils/safeUrl'
import type { RefObject } from 'react'

type ExternalLinkNavigation = {
  href: string
  shouldOpenExternal: boolean
}

const getExternalLinkNavigation = (
  href: string
): ExternalLinkNavigation | null => {
  const safeHref = sanitizeUserHref(href)
  if (!safeHref) {
    return null
  }

  const { enableRedirect, excludedDomains } = getKunUserSnapshot()
  const hostname = getHttpUrlHostname(safeHref)
  const isExcludedDomain = hostname
    ? isHostnameExcluded(hostname, excludedDomains)
    : false
  const shouldRedirect =
    !isExcludedDomain && enableRedirect && isRedirectableUrl(safeHref)

  return {
    href: shouldRedirect
      ? `/redirect?url=${encodeURIComponent(safeHref)}`
      : safeHref,
    shouldOpenExternal: !enableRedirect && isRedirectableUrl(safeHref)
  }
}

const getClosestExternalLink = (
  target: EventTarget | null,
  content: HTMLElement
) => {
  if (!(target instanceof Element)) {
    return null
  }

  const anchor = target.closest('a[data-kun-external-link]')
  return anchor instanceof HTMLAnchorElement && content.contains(anchor)
    ? anchor
    : null
}

// 对服务端富文本 (dangerouslySetInnerHTML) 中带 data-kun-external-link 标记的
// 链接做事件委托: 在交互发生前按用户配置把 href 重写为 /redirect 跳转页
export const useKunExternalLinkNavigation = (
  contentRef: RefObject<HTMLElement | null>,
  html: string
) => {
  useEffect(() => {
    const content = contentRef.current
    if (!content) {
      return
    }

    const applyExternalLinkNavigation = (anchor: HTMLAnchorElement) => {
      const href =
        anchor.getAttribute('data-href') || anchor.getAttribute('href')
      const navigation = href ? getExternalLinkNavigation(href) : null
      if (!navigation) {
        anchor.removeAttribute('href')
        anchor.removeAttribute('target')
        anchor.removeAttribute('rel')
        return false
      }

      anchor.setAttribute('href', navigation.href)
      if (navigation.shouldOpenExternal) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer')
      } else {
        anchor.removeAttribute('target')
        anchor.removeAttribute('rel')
      }

      return true
    }

    const handleExternalLinkPrepare = (event: Event) => {
      const anchor = getClosestExternalLink(event.target, content)
      if (anchor) {
        applyExternalLinkNavigation(anchor)
      }
    }

    const handleExternalLinkClick = (event: MouseEvent) => {
      const anchor = getClosestExternalLink(event.target, content)
      if (anchor && !applyExternalLinkNavigation(anchor)) {
        event.preventDefault()
      }
    }

    content.addEventListener('pointerdown', handleExternalLinkPrepare)
    content.addEventListener('contextmenu', handleExternalLinkPrepare)
    content.addEventListener('focusin', handleExternalLinkPrepare)
    content.addEventListener('click', handleExternalLinkClick)

    return () => {
      content.removeEventListener('pointerdown', handleExternalLinkPrepare)
      content.removeEventListener('contextmenu', handleExternalLinkPrepare)
      content.removeEventListener('focusin', handleExternalLinkPrepare)
      content.removeEventListener('click', handleExternalLinkClick)
    }
  }, [contentRef, html])
}
