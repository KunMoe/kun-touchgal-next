import { describe, expect, it } from 'vitest'
import { isValidElement } from 'react'
import Link from 'next/link'
import NotFound, { metadata } from '~/app/not-found'

interface RenderedElement {
  type: unknown
  props: Record<string, unknown> & { children?: unknown }
}

const flatten = (node: unknown): RenderedElement[] => {
  if (Array.isArray(node)) {
    return node.flatMap(flatten)
  }
  if (!isValidElement(node)) {
    return []
  }
  const element = node as RenderedElement
  return [element, ...flatten(element.props.children)]
}

describe('app/not-found', () => {
  it('同步渲染 (不是 async 组件), 有标题并带回首页的链接', () => {
    const elements = flatten(NotFound())

    expect(elements.filter((el) => el.type === 'h1')).toHaveLength(1)
    expect(
      elements.filter((el) => el.type === Link).map((el) => el.props.href)
    ).toEqual(['/'])
  })

  it('给 404 页面单独的标题, 不沿用根布局的可索引设置与规范地址', () => {
    expect(metadata.title).toBe('页面不存在')
    expect(metadata.robots).toMatchObject({ index: false, follow: false })
    expect(metadata.alternates).toBeNull()
  })
})
