import { createElement, isValidElement, ReactElement, ReactNode } from 'react'

const getTextContent = (children: ReactNode): string => {
  if (typeof children === 'string') {
    return children
  }

  if (Array.isArray(children)) {
    return children.map((child) => getTextContent(child)).join('')
  }

  if (isValidElement(children)) {
    // TODO: resolve this any
    return getTextContent((children.props as any)?.children)
  }

  if (children && typeof children === 'object' && 'props' in children) {
    // TODO: resolve this any
    return getTextContent((children.props as any).children)
  }

  return ''
}

export const slugify = (str: string): string => {
  return str
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/&/g, '-and-')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const createKunHeading = (level: number) => {
  const Heading = ({ children }: { children: ReactNode }) => {
    const text = getTextContent(children)
    const slug = slugify(text)

    return createElement(
      `h${level}`,
      { id: slug, className: 'group/heading relative' },
      children,
      createElement(
        'a',
        {
          href: `#${slug}`,
          key: `kun-link-${slug}`,
          className: 'kun-anchor',
          'aria-label': `链接到本节: ${text}`
        },
        '#'
      )
    )
  }

  Heading.displayName = `KunHeading${level}`

  return Heading
}
