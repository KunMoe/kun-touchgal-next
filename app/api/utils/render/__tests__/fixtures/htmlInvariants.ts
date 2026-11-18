import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference'
import {
  SAFE_LINK_PROTOCOL_NAMES,
  SAFE_MEDIA_PROTOCOL_NAMES
} from '~/utils/safeUrl'
import type { KunCorpusInvariant } from './markdownCorpus'

// 渲染输出的净化不变量。刻意不读净化策略本身: 拿策略检查策略等于没查, 这里是另写的
// 一份判据, 策略被改宽 (放行了能跑脚本的元素、事件属性、危险协议) 时由它报出来

interface HtmlTag {
  name: string
  attributes: Map<string, string>
}

// 输入只会是 rehype-stringify 的产物: 文本里的 < 一律转义, 属性值一律双引号包裹
// (值里的 < > 不转义)。所以裸露的 < 必是标签起点, 按「名字 → 属性 → 收尾」顺序读即可
const TAG_NAME = /<([a-zA-Z][^\s/>]*)/y
const ATTRIBUTE = /\s+([^\s"'<>/=]+)(?:="([^"]*)")?/y
const TAG_END = /\s*\/?>/y

const decodeCharacterReferences = (value: string) =>
  value.replace(
    /&(?:#[xX]([\da-fA-F]+)|#(\d+)|([\da-zA-Z]+));/g,
    (whole, hexadecimal, decimal, named) => {
      if (hexadecimal !== undefined) {
        return decodeNumericCharacterReference(hexadecimal, 16)
      }
      if (decimal !== undefined) {
        return decodeNumericCharacterReference(decimal, 10)
      }
      return decodeNamedCharacterReference(named) || whole
    }
  )

// 读不懂的形状直接抛错, 不猜: 检测器看不懂的输出不能算通过
const parseTags = (html: string): HtmlTag[] => {
  const tags: HtmlTag[] = []
  let index = html.indexOf('<')

  while (index !== -1) {
    if (html[index + 1] === '/') {
      index = html.indexOf('<', index + 1)
      continue
    }

    TAG_NAME.lastIndex = index
    const name = TAG_NAME.exec(html)
    if (!name) {
      throw new Error(`无法解析的标签: ${html.slice(index, index + 40)}`)
    }

    const attributes = new Map<string, string>()
    let cursor = TAG_NAME.lastIndex
    for (;;) {
      ATTRIBUTE.lastIndex = cursor
      const attribute = ATTRIBUTE.exec(html)
      if (!attribute) {
        break
      }
      attributes.set(
        attribute[1].toLowerCase(),
        decodeCharacterReferences(attribute[2] ?? '')
      )
      cursor = ATTRIBUTE.lastIndex
    }

    TAG_END.lastIndex = cursor
    if (!TAG_END.test(html)) {
      throw new Error(`无法解析的标签: ${html.slice(index, cursor + 40)}`)
    }

    tags.push({ name: name[1].toLowerCase(), attributes })
    index = html.indexOf('<', TAG_END.lastIndex)
  }

  return tags
}

// 能执行脚本、嵌入外部文档或改写页面行为的元素。SVG 的动画元素能在运行时把别的
// 元素的 href 改成任意地址, foreignObject 能把 HTML 再嵌回来
const FORBIDDEN_ELEMENTS = new Set([
  'set',
  'animate',
  'animatetransform',
  'animatemotion',
  'foreignobject',
  'use',
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'base',
  'link',
  'meta',
  'noscript',
  'template',
  'math'
])

const LINK_URL_ATTRIBUTES = ['href', 'data-href', 'cite', 'longdesc']
const MEDIA_URL_ATTRIBUTES = ['src', 'data-src', 'poster']
// 渲染管线从不产生这些属性, 出现即视为地址逃出了协议检查
const UNEXPECTED_URL_ATTRIBUTES = [
  'action',
  'formaction',
  'xlink:href',
  'background',
  'ping',
  'srcset'
]

// 按浏览器的读法取协议: 先丢掉空白与控制字符 (地址里的制表符、换行会被浏览器忽略,
// java<TAB>script: 仍是 javascript:), 再看开头是不是「字母 + 字母数字 + - . 」加冒号
const schemeOf = (url: string) => {
  // eslint-disable-next-line no-control-regex -- 要去掉的正是控制字符
  const compact = url.replace(/[\u0000- ]/g, '')
  const match = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(compact)
  return match ? match[1].toLowerCase() : null
}

const hasUnsafeUrl = (tag: HtmlTag) => {
  const allows = (names: readonly string[], allowed: readonly string[]) =>
    names.every((name) => {
      const value = tag.attributes.get(name)
      if (value === undefined) {
        return true
      }
      const scheme = schemeOf(value)
      return scheme === null || allowed.includes(scheme)
    })

  return (
    !allows(LINK_URL_ATTRIBUTES, SAFE_LINK_PROTOCOL_NAMES) ||
    !allows(MEDIA_URL_ATTRIBUTES, SAFE_MEDIA_PROTOCOL_NAMES) ||
    UNEXPECTED_URL_ATTRIBUTES.some((name) => tag.attributes.has(name))
  )
}

const decodeFragment = (fragment: string) => {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

// id / name 会在 document 与 window 上生成同名属性, 用户能起名字就能顶掉页面脚本
// 要用的全局变量。管线放行它们时必须加前缀
const CLOBBER_PREFIX = 'user-content-'

const hasClobberingName = (tag: HtmlTag) =>
  ['id', 'name'].some((name) => {
    const value = tag.attributes.get(name)
    return value !== undefined && !value.startsWith(CLOBBER_PREFIX)
  })

// 管线自己生成的页内链接 (脚注的引用与回链) 要能在同一份输出里找到对应的 id。
// 用户手写的 #片段 可以指向页面上任何地方, 不归这一条管
const hasDanglingFragment = (tags: HtmlTag[]) => {
  const ids = new Set(
    tags.flatMap((tag) => {
      const id = tag.attributes.get('id')
      return id === undefined ? [] : [id]
    })
  )
  return tags.some((tag) => {
    const href = tag.attributes.get('href')
    if (href === undefined || !href.startsWith(`#${CLOBBER_PREFIX}`)) {
      return false
    }
    // 浏览器先按原样找, 找不到再按百分号解码后的样子找
    const fragment = href.slice(1)
    return !ids.has(fragment) && !ids.has(decodeFragment(fragment))
  })
}

// 返回被违反的不变量, 顺序固定; 全部成立时为空数组
export const findInvariantViolations = (html: string): KunCorpusInvariant[] => {
  const tags = parseTags(html)
  const violations: KunCorpusInvariant[] = []

  if (tags.some((tag) => FORBIDDEN_ELEMENTS.has(tag.name))) {
    violations.push('forbidden-element')
  }
  if (
    tags.some((tag) =>
      [...tag.attributes.keys()].some((name) => name.startsWith('on'))
    )
  ) {
    violations.push('event-handler')
  }
  if (tags.some((tag) => tag.attributes.has('style'))) {
    violations.push('inline-style')
  }
  if (tags.some(hasUnsafeUrl)) {
    violations.push('unsafe-url')
  }
  if (tags.some(hasClobberingName)) {
    violations.push('dom-clobbering')
  }
  if (hasDanglingFragment(tags)) {
    violations.push('fragment-target')
  }

  return violations
}
