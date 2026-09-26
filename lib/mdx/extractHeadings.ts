import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { slugify } from './element/kunHeading'
import type { Node } from 'unist'
import type { TOCItem } from './types'

// 与 kunHeading 的 getTextContent 对齐: React 只取子节点文本, 不含图片 alt 与原始 HTML 标签
const getHeadingText = (node: Node): string => {
  if ('value' in node) {
    return node.type === 'html' ? '' : String(node.value)
  }

  if ('children' in node) {
    return (node.children as Node[]).map(getHeadingText).join('')
  }

  return ''
}

// 构建期从 MDX 源码提取 h1-h3, 让目录随 SSG HTML 直出, 不再等水合后扫描 DOM
export const extractKunHeadings = (content: string): TOCItem[] => {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content)
  const headings: TOCItem[] = []

  visit(tree, 'heading', (node) => {
    if (node.depth > 3) {
      return
    }

    const text = getHeadingText(node)
    const id = slugify(text)

    if (id && text) {
      headings.push({ id, text, level: node.depth })
    }
  })

  return headings
}
