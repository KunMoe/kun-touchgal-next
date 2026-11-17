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
// 语法面只有「独占一行的短代码」: `::名字[标签]{属性}`。另外两种指令形态刻意不解析:
// - 行内的 `:名字` 正好覆盖「10:30」「CV:名字」「Re:Zero」这类普通文字, 解析了就得
//   有人决定怎么处置它们, 历史上的处置是删掉;
// - 容器 `:::名字 … :::` 没有任何短代码用得上, 解析它只带来成本: 嵌套的容器让解析
//   耗时按层数叠加 (2000 层约 5 秒), 得另靠一个预先数行的熔断兜着。
// 不解析的写法就是普通文字。
//
// 语义面只有下面注册表里的名字。没注册的名字、属性填了却不合格的, 都还原成用户写下的
// 那一行文字, 不消失也不变成空标签。唯一的例外是「地址没填」的已注册短代码: 那是没
// 填完的模板 (投稿模板会留下 `::kun-link{href="" text="…"}`), 发布时不显示, 编辑器
// 里保留

type KunDirectiveAttributes = Record<string, string | null | undefined>

interface KunDirectiveSpec<T> {
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
    parse: parseKunVideoAttrs,
    blank: (attributes) => (isBlank(attributes.src) ? { src: '' } : null)
  },
  'kun-link': {
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
  type: 'leafDirective'
  name: string
  attributes?: KunDirectiveAttributes | null
}

interface ParentNode extends Node {
  children: Node[]
}

const isParent = (node: Node): node is ParentNode =>
  Array.isArray((node as Partial<ParentNode>).children)

const isDirective = (node: Node): node is DirectiveNode =>
  node.type === 'leafDirective'

// 合格 → valid; 地址没填 → blank; 其余 (没注册, 或填了却不合格) → null
const resolveDirective = (node: DirectiveNode) => {
  // 指令名来自用户输入: `::constructor` 不能命中原型上的属性
  if (!Object.hasOwn(KUN_DIRECTIVES, node.name)) {
    return null
  }
  const name = node.name as KunDirectiveName
  const spec = KUN_DIRECTIVES[name]
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

type TreeTransform = (tree: ParentNode) => ParentNode | null | undefined | void

// 上游把容器与整行两种块级构造放在同一张表里, 没有名字可认; 容器是其中唯一标了
// concrete 的 (它里面还要再放块)。只留整行的那一种
const leafSyntax = () => ({
  flow: Object.fromEntries(
    Object.entries(directive().flow ?? {}).map(([code, constructs]) => [
      code,
      [constructs ?? []].flat().filter((construct) => !construct.concrete)
    ])
  )
})

// 序列化 (编辑器写回 markdown) 时的转义规则。只有两条: 标签里的换行, 以及行首的 `::`。
// 刻意不沿用上游的规则表: 上游还会转义正文里的冒号, 而本方言不解析行内指令, 那条转义
// 只会在用户的文字里留下多余的反斜杠
const KUN_DIRECTIVE_UNSAFE = [
  { character: '\r', inConstruct: ['leafDirectiveLabel'] },
  { character: '\n', inConstruct: ['leafDirectiveLabel'] },
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
  register('micromarkExtensions', leafSyntax())
  register('fromMarkdownExtensions', directiveFromMarkdown())
  register('toMarkdownExtensions', {
    handlers: directiveToMarkdown().handlers,
    unsafe: KUN_DIRECTIVE_UNSAFE
  })

  return (tree: Node, file: { value: unknown }): void => {
    // 原文还原靠源码切片: 调用方要把原文一并交给 run (process 自带)。
    // 空文档在 vfile 里没有 value, 与「没给原文」分不开, 所以到真要切片时才检查
    const text = typeof file.value === 'string' ? file.value : ''
    // 解析器跳过文档开头的 BOM, 节点位置是按去掉它之后算的
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

    // 解析器在建树之后还会对文字做一遍变换 (GFM 把裸网址变成链接)。还原出来的文字
    // 没经过解析器, 要补上同一遍: 否则这一行在编辑器里保存一次之后, 发布出来的样子
    // 就变了 —— 转义挡不住那遍变换, 再解析时网址会变成链接
    let treeTransforms: TreeTransform[] | undefined

    // 还原成用户写下的那一行文字
    const restore = (node: DirectiveNode): Node[] => {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (typeof start !== 'number' || typeof end !== 'number') {
        return []
      }
      if (end > source.length) {
        throw new Error('remarkKunDirectives 需要原文: 以 run(tree, 原文) 调用')
      }

      treeTransforms ??= (data.fromMarkdownExtensions ?? [])
        .flat(Infinity)
        .flatMap(
          (extension) =>
            (extension as { transforms?: TreeTransform[] }).transforms ?? []
        )
      let root: ParentNode = {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'text', value: source.slice(start, end) }]
          } as Node
        ]
      }
      for (const transformTree of treeTransforms) {
        root = transformTree(root) ?? root
      }
      return root.children
    }

    const transform = (parent: ParentNode) => {
      const children: Node[] = []
      for (const child of parent.children) {
        if (!isDirective(child)) {
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
