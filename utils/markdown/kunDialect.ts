import {
  directiveFromMarkdown,
  directiveToMarkdown
} from 'mdast-util-directive'
import { directive } from 'micromark-extension-directive'
import {
  SAFE_MEDIA_PROTOCOLS,
  sanitizeUserHref,
  sanitizeUserUrl
} from '~/utils/safeUrl'
import type { Processor } from 'unified'
import type { Node } from 'unist'

// 站点 markdown 的指令方言, 可视化编辑器与服务端渲染共用同一份。
//
// 语法面只有「独占一行的指令」: `::名字[标签]{属性}`, 以及 `:::名字 … :::` 容器。
// 行内的 `:名字` 形态刻意不解析 —— 它正好覆盖「10:30」「CV:名字」「Re:Zero」这类
// 普通文字, 解析了就得有人决定怎么处置它们, 历史上的处置是删掉。
//
// 语义面只有下面注册表里的名字。其余一律按原文显示: 没注册的名字、注册了但写成容器
// 形态、属性填了却不合格的, 都还原成用户写下的那一行文字, 不消失也不变成空标签。
// 唯一的例外是「地址没填」的已注册短代码: 那是没填完的模板 (投稿模板会留下
// `::kun-link{href="" text="…"}`), 发布时不显示, 编辑器里保留

type KunDirectiveAttributes = Record<string, string | null | undefined>

interface KunDirectiveSpec<T> {
  readonly type: 'leafDirective'
  // 属性不合格时返回 null; 返回值即渲染与编辑器节点拿到的属性
  readonly parse: (attributes: KunDirectiveAttributes) => T | null
  // 地址没填时返回编辑器里保留这个节点用的属性, 否则返回 null
  readonly blank: (attributes: KunDirectiveAttributes) => T | null
}

export const parseKunVideoAttrs = (attributes: KunDirectiveAttributes) => {
  const src =
    typeof attributes.src === 'string'
      ? sanitizeUserUrl(attributes.src, SAFE_MEDIA_PROTOCOLS)
      : null
  return src ? { src } : null
}

export const parseKunLinkAttrs = (attributes: KunDirectiveAttributes) => {
  const href =
    typeof attributes.href === 'string'
      ? sanitizeUserHref(attributes.href)
      : null
  const text = typeof attributes.text === 'string' ? attributes.text : ''
  return href && text ? { href, text } : null
}

const isBlank = (value: string | null | undefined) => !value?.trim()

// 新增一个短代码: 在这里登记, 再给它写服务端的渲染插件与编辑器节点
export const KUN_DIRECTIVES = {
  'kun-video': {
    type: 'leafDirective',
    parse: parseKunVideoAttrs,
    blank: (attributes) => (isBlank(attributes.src) ? { src: '' } : null)
  },
  'kun-link': {
    type: 'leafDirective',
    parse: parseKunLinkAttrs,
    blank: (attributes) =>
      isBlank(attributes.href)
        ? { href: '', text: attributes.text ?? '' }
        : null
  }
} as const satisfies Record<string, KunDirectiveSpec<unknown>>

export type KunDirectiveName = keyof typeof KUN_DIRECTIVES

export type KunDirectiveAttrs<Name extends KunDirectiveName> = NonNullable<
  ReturnType<(typeof KUN_DIRECTIVES)[Name]['parse']>
>

interface DirectiveNode extends Node {
  name: string
  attributes?: KunDirectiveAttributes | null
  children: Node[]
}

interface ParentNode extends Node {
  children: Node[]
}

const isParent = (node: Node): node is ParentNode =>
  Array.isArray((node as Partial<ParentNode>).children)

const isFlowDirective = (node: Node): node is DirectiveNode =>
  node.type === 'leafDirective' || node.type === 'containerDirective'

// 合格 → valid; 地址没填 → blank; 其余 (没注册、形态不符、填了却不合格) → null
const resolveDirective = (node: DirectiveNode) => {
  // 指令名来自用户输入: `::constructor` 不能命中原型上的属性
  if (!Object.hasOwn(KUN_DIRECTIVES, node.name)) {
    return null
  }
  const name = node.name as KunDirectiveName
  const spec = KUN_DIRECTIVES[name]
  if (spec.type !== node.type) {
    return null
  }
  const attributes = node.attributes ?? {}
  const attrs = spec.parse(attributes)
  if (attrs) {
    return { state: 'valid' as const, kun: { name, attrs } }
  }
  const blankAttrs = spec.blank(attributes)
  return blankAttrs
    ? { state: 'blank' as const, kun: { name, attrs: blankAttrs } }
    : null
}

// 指令节点上的标记, 由 remarkKunDirectives 写入。渲染插件与编辑器节点只认这个标记,
// 不各自再比名字、校验属性
export const readKunDirective = <Name extends KunDirectiveName>(
  node: Node,
  name: Name
): KunDirectiveAttrs<Name> | null => {
  const kun = (
    node.data as { kun?: { name: string; attrs: unknown } } | undefined
  )?.kun
  return node.type === 'leafDirective' && kun?.name === name
    ? (kun.attrs as KunDirectiveAttrs<Name>)
    : null
}

const literalParagraph = (value: string): Node =>
  ({ type: 'paragraph', children: [{ type: 'text', value }] }) as Node

type TreeTransform = (tree: ParentNode) => ParentNode | null | undefined | void

// 收尾栅栏: 行首可以带引用 / 列表的续行前缀
const CLOSING_FENCE = /^[ \t>]*(:{3,})[ \t]*$/

// 序列化 (编辑器写回 markdown) 时的转义规则。只有两条: 标签里的换行, 以及行首的 `::`。
// 刻意不沿用上游的规则表: 上游还会转义正文里的冒号, 而本方言不解析行内指令, 那条转义
// 只会在用户的文字里留下多余的反斜杠
const KUN_DIRECTIVE_UNSAFE = [
  {
    character: '\r',
    inConstruct: ['leafDirectiveLabel', 'containerDirectiveLabel']
  },
  {
    character: '\n',
    inConstruct: ['leafDirectiveLabel', 'containerDirectiveLabel']
  },
  { atBreak: true, character: ':', after: ':' }
]

export interface KunDirectiveOptions {
  // render: 合格的指令留给后续插件渲染, 地址没填的不显示
  // drop:   已注册的指令一概不显示
  // edit:   编辑器用。与 render 的区别只在地址没填的指令也保留成节点, 保存时原样
  //         写回 —— 否则打开再保存就会悄悄删掉这一行
  mode: 'render' | 'drop' | 'edit'
}

// 签名刻意不套 unified 的 Plugin 别名: 那样变换器的返回类型会被钉成具体的树类型,
// 服务端 (unist Node) 与 milkdown (mdast Root) 就没法共用同一个声明
export const remarkKunDirectives = function (
  this: Processor,
  { mode }: KunDirectiveOptions
) {
  const data = this.data() as Record<string, unknown[] | undefined>
  const register = (key: string, extension: unknown) => {
    ;(data[key] ??= []).push(extension)
  }
  // 只取块级构造: 行内的 `:名字` 不注册, 普通文字里的冒号不会被读成指令
  register('micromarkExtensions', { flow: directive().flow })
  register('fromMarkdownExtensions', directiveFromMarkdown())
  register('toMarkdownExtensions', {
    handlers: directiveToMarkdown().handlers,
    unsafe: KUN_DIRECTIVE_UNSAFE
  })

  return (tree: Node, file: { value: unknown }): void => {
    // 原文还原靠源码切片: 调用方要把原文一并交给 run (process 自带)。
    // 空文档在 vfile 里没有 value, 与「没给原文」分不开, 所以到真要切片时才检查
    const source = typeof file.value === 'string' ? file.value : ''

    // 解析器在建树之后还会对文字做一遍变换 (GFM 把裸网址变成链接)。还原出来的文字
    // 没经过解析器, 要补上同一遍: 否则这一行在编辑器里保存一次之后, 发布出来的样子
    // 就变了 —— 转义挡不住那遍变换, 再解析时网址会变成链接
    let treeTransforms: TreeTransform[] | undefined
    const literalBlocks = (lines: string[]): Node[] => {
      treeTransforms ??= (
        (this.data() as Record<string, unknown[] | undefined>)
          .fromMarkdownExtensions ?? []
      )
        .flat(Infinity)
        .flatMap(
          (extension) =>
            (extension as { transforms?: TreeTransform[] }).transforms ?? []
        )
      let root: ParentNode = {
        type: 'root',
        children: lines.map(literalParagraph)
      }
      for (const transformTree of treeTransforms) {
        root = transformTree(root) ?? root
      }
      return root.children
    }

    const restore = (node: DirectiveNode): Node[] => {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (typeof start !== 'number' || typeof end !== 'number') {
        return []
      }
      if (end > source.length) {
        throw new Error('remarkKunDirectives 需要原文: 以 run(tree, 原文) 调用')
      }
      const raw = source.slice(start, end)
      if (node.type === 'leafDirective') {
        return literalBlocks([raw])
      }

      // 容器: 开、闭栅栏各还原成一行文字, 里面的内容照常渲染
      const lines = raw.split(/\r\n|\n|\r/)
      const opening = lines[0]
      const openingSize = /^:*/.exec(opening)?.[0].length ?? 0
      const closing =
        lines.length > 1 ? CLOSING_FENCE.exec(lines[lines.length - 1]) : null
      const body: ParentNode = {
        type: 'root',
        // 标签已包含在开栅栏那一行里
        children: node.children.filter(
          (child) =>
            !(child.data as { directiveLabel?: boolean } | undefined)
              ?.directiveLabel
        )
      }
      transform(body)

      return [
        ...literalBlocks([opening]),
        ...body.children,
        // 比开栅栏短的冒号行不是收尾, 它本来就在内容里
        ...(closing && closing[1].length >= openingSize
          ? [literalParagraph(closing[1])]
          : [])
      ]
    }

    const transform = (parent: ParentNode) => {
      const children: Node[] = []
      for (const child of parent.children) {
        if (!isFlowDirective(child)) {
          if (isParent(child)) {
            transform(child)
          }
          children.push(child)
          continue
        }

        const resolved = resolveDirective(child)
        if (!resolved) {
          children.push(...restore(child))
        } else if (
          mode === 'edit' ||
          (mode === 'render' && resolved.state === 'valid')
        ) {
          child.data = { ...child.data, kun: resolved.kun }
          children.push(child)
        }
      }
      parent.children = children
    }

    if (isParent(tree)) {
      transform(tree)
    }
  }
}
