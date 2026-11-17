'use client'

import { $command, $inputRule, $node } from '@milkdown/utils'
import { Node } from '@milkdown/prose/model'
import { InputRule } from '@milkdown/prose/inputrules'
import {
  useNodeViewContext,
  type ReactNodeViewUserOptions
} from '@prosemirror-adapter/react'
import {
  parseKunLinkAttrs,
  readKunDirective
} from '~/utils/markdown/kunDialect'
import { KunLink } from './KunLink'

interface InsertKunLinkCommandPayload {
  href: string
  text: string
}

// leaf 节点, 理由同 videoPlugin.tsx 的 videoNode
export const kunLinkNode = $node('kun-link', () => ({
  group: 'block',
  selectable: true,
  draggable: true,
  marks: '',
  attrs: {
    href: { default: '' },
    text: { default: '' }
  },
  parseDOM: [
    {
      tag: 'div[data-kun-link]',
      getAttrs: (dom) =>
        parseKunLinkAttrs({
          href: dom.getAttribute('data-href'),
          text: dom.getAttribute('data-text')
        }) ?? false
    }
  ],
  // 只服务剪贴板 / 拖拽的 HTML 序列化, 编辑器内的实际渲染走下方 nodeView
  toDOM: (node: Node) => [
    'div',
    {
      'data-kun-link': '',
      'data-href': node.attrs.href,
      'data-text': node.attrs.text
    }
  ],
  // 只认方言插件标记过的节点, 理由同 videoPlugin.tsx
  parseMarkdown: {
    match: (node) => readKunDirective(node, 'kun-link') !== null,
    runner: (state, node, type) => {
      state.addNode(type, readKunDirective(node, 'kun-link') ?? undefined)
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'kun-link',
    runner: (state, node) => {
      state.addNode('leafDirective', undefined, node.attrs.text, {
        name: 'kun-link',
        attributes: node.attrs
      })
    }
  }
}))

const KunLinkView = () => {
  const { node } = useNodeViewContext()
  return <KunLink href={node.attrs.href} text={node.attrs.text} />
}

// 生命周期交给 @prosemirror-adapter, 理由同 videoPlugin.tsx 的 kunVideoNodeViewOptions
export const kunLinkNodeViewOptions: ReactNodeViewUserOptions = {
  component: KunLinkView
}

export const insertKunLinkCommand = $command(
  'InsertKunLink',
  (ctx) =>
    (payload: InsertKunLinkCommandPayload = { href: '', text: '' }) =>
    (state, dispatch) => {
      // 发布端不认的链接不建节点, 理由同 videoPlugin.tsx
      const attrs = parseKunLinkAttrs({
        href: payload.href,
        text: payload.text
      })
      if (!attrs) return false
      if (!dispatch) return true

      const node = kunLinkNode.type(ctx).create(attrs)

      if (!node) return true

      dispatch(state.tr.replaceSelectionWith(node).scrollIntoView())
      return true
    }
)

export const kunLinkInputRule = $inputRule(
  (ctx) =>
    new InputRule(
      // Matches format: [[text]](url)
      /\[\[(?<text>[^\]]+)\]\]\((?<href>[^)]+)\)/,
      (state, match, start, end) => {
        const [matched, text = '', href = ''] = match
        const { tr } = state
        const attrs = matched ? parseKunLinkAttrs({ href, text }) : null

        if (attrs) {
          return tr.replaceWith(
            start - 1,
            end,
            kunLinkNode.type(ctx).create(attrs)
          )
        }
        return null
      }
    )
)
