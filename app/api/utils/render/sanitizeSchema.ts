// 净化策略属于渲染策略: 改了要递增 profiles.ts 里用到它的 profile 的版本 (评论还要在
// 发布后运行 `pnpm backfill:comment-html`), 否则旧落库 HTML 仍按旧策略服务用户。
// 漏递增会被 profileLock.test.ts 拦下。
// markdownBudget.ts 里的渲染预算同属渲染策略, 改动时照此办理: 超出预算的评论是把降级
// 结果按当前版本落库的, 不递增版本就放宽预算, 这些行会一直停在降级输出上。
import { defaultSchema } from 'rehype-sanitize'
import {
  SAFE_LINK_PROTOCOL_NAMES,
  SAFE_MEDIA_PROTOCOL_NAMES
} from '~/utils/safeUrl'
import type { Options as RehypeSanitizeOptions } from 'rehype-sanitize'

const defaultProtocols = defaultSchema.protocols || {}

// 脚注的锚点。上游生成时已经带了 user-content- 前缀 (页面脚本用不到这个名字空间),
// 这里按形状放行, 不再让净化库加一遍前缀 —— 加了就和脚注链接里的地址对不上
const FOOTNOTE_REFERENCE_ID = /^user-content-fnref-/
const FOOTNOTE_DEFINITION_ID = /^user-content-fn-/

const linkAttributes = [
  'data-kun-external-link',
  'data-href',
  'data-text',
  'href',
  'title',
  'target',
  'rel',
  'className',
  ['id', FOOTNOTE_REFERENCE_ID] as [string, RegExp]
]

const imageAttributes = ['src', 'alt', 'title', 'class', 'loading']
const svgAttributes = [
  'aria-hidden',
  'className',
  'fill',
  'height',
  'shapeRendering',
  'stroke',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeWidth',
  'viewBox',
  'width'
]
const pathAttributes = ['d']

const safeProtocols = {
  ...defaultProtocols,
  href: SAFE_LINK_PROTOCOL_NAMES,
  src: SAFE_MEDIA_PROTOCOL_NAMES,
  'data-href': SAFE_LINK_PROTOCOL_NAMES,
  'data-src': SAFE_MEDIA_PROTOCOL_NAMES
}

// 只追加: 在 base 之上多放行一些标签与属性。没有「替换某一项」的写法, 派生出来的
// 策略只会比 base 多放行这里列出的东西
export const extendSanitizeSchema = (
  base: RehypeSanitizeOptions,
  patch: {
    tagNames?: readonly string[]
    attributes?: NonNullable<RehypeSanitizeOptions['attributes']>
  }
): RehypeSanitizeOptions => {
  const attributes = { ...base.attributes }
  for (const [tagName, names] of Object.entries(patch.attributes ?? {})) {
    attributes[tagName] = [...(attributes[tagName] ?? []), ...names]
  }

  return {
    ...base,
    tagNames: [...(base.tagNames ?? []), ...(patch.tagNames ?? [])],
    attributes
  }
}

// 属性表不沿用默认的那一大张, 只列管线自己会生成的: 原始 HTML 不进树, 用不上别的。
// 任务列表的勾选、表格对齐、列表起始编号、链接标题、脚注锚点都在这里 (09-03 #5)
export const markdownSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  attributes: {
    a: linkAttributes,
    img: imageAttributes,
    input: ['checked'],
    li: [['id', FOOTNOTE_DEFINITION_ID]],
    ol: ['start'],
    td: ['align'],
    th: ['align']
  },
  // id 已按形状限定为脚注锚点, 不在这里加前缀
  clobber: (defaultSchema.clobber ?? []).filter((name) => name !== 'id'),
  protocols: safeProtocols
}

export const markdownExtendSanitizeSchema = extendSanitizeSchema(
  markdownSanitizeSchema,
  {
    tagNames: ['svg', 'path'],
    attributes: {
      div: [
        'data-video-player',
        'data-src',
        'data-kun-link',
        'data-href',
        'data-text',
        'data-kun-img-container',
        'role',
        'tabIndex',
        'aria-label',
        'className'
      ],
      svg: svgAttributes,
      path: pathAttributes
    }
  }
)
