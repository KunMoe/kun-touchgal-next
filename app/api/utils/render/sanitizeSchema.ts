// 修改本文件中的 sanitize 策略后，必须在
// app/api/utils/render/markdownToHtmlComment.ts 中递增 COMMENT_HTML_VERSION，
// 并运行 `pnpm backfill:comment-html` 重新渲染所有评论，否则旧落库 HTML 仍按旧策略服务用户。
// markdownBudget.ts 里的渲染预算同属渲染策略，改动时照此办理：超出预算的评论是把降级
// 结果按当前版本落库的，不递增版本就放宽预算，这些行会一直停在降级输出上。
import { defaultSchema } from 'rehype-sanitize'
import {
  SAFE_LINK_PROTOCOL_NAMES,
  SAFE_MEDIA_PROTOCOL_NAMES
} from '~/utils/safeUrl'
import type { Options as RehypeSanitizeOptions } from 'rehype-sanitize'

const defaultProtocols = defaultSchema.protocols || {}

const linkAttributes = [
  'data-kun-external-link',
  'data-href',
  'data-text',
  'href',
  'target',
  'rel',
  'className'
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

// attributes 整体替换了默认表: 默认放行的 checked / align / start / title / id 等
// 都被剥掉 (09-03 #5, 待裁定)。恢复哪些属于渲染策略变更
export const markdownSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  attributes: {
    a: linkAttributes,
    img: imageAttributes
  },
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
