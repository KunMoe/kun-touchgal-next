import { compile } from 'html-to-text'
import type { FormatCallback } from 'html-to-text'
import type { KunSafeHtml } from '~/types/content'
import { sliceCodePoints } from '~/utils/text/unicode'

// 全仓唯一的「HTML → 纯文本」投影, 也是唯一允许 import html-to-text 的文件
// (inv-content-01)。输入必须是渲染管线产出的已净化 HTML: 对 markdown 原文跑 HTML
// 转换器会把 `<…>` 当标签吞掉 (P05-03), 同一段 HTML 用两套选项会得到两种描述 (D11-01)

// display 给人看: 描述、预览、摘要。不带链接地址与图片, 跳过外链卡片与视频占位
// audit   给审核看: 读者点得到、看得到的地址都要保留
export type KunTextMode = 'display' | 'audit'

// html-to-text 默认把标题转成大写, 拉丁字母的游戏名会被改写
const HEADING_SELECTORS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(
  (selector) => ({ selector, options: { uppercase: false } })
)
const TABLE_SELECTOR = {
  selector: 'table',
  options: { uppercaseHeaderCells: false }
}

// alt 在图片加载失败时直接显示在页面上, title 悬停可见: 读者看得到的都要给审核看。
// 原文里它们可以写成字符实体 (&#21152;…), 只有渲染后的属性值才是可读文字
const formatImage: FormatCallback = (elem, _walk, builder) => {
  const parts = [elem.attribs?.alt, elem.attribs?.title, elem.attribs?.src]
    .filter(Boolean)
    .join(' ')
  if (parts) {
    builder.addInline(`[图片 ${parts}]`)
  }
}

const formatVideo: FormatCallback = (elem, _walk, builder) => {
  const src = elem.attribs?.['data-src']
  builder.openBlock()
  if (src) {
    builder.addInline(`[视频 ${src}]`)
  }
  builder.closeBlock()
}

const converters = {
  display: compile({
    wordwrap: false,
    selectors: [
      ...HEADING_SELECTORS,
      TABLE_SELECTOR,
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'div[data-kun-link]', format: 'skip' },
      { selector: 'div[data-video-player]', format: 'skip' }
    ]
  }),
  audit: compile({
    wordwrap: false,
    formatters: { kunImage: formatImage, kunVideo: formatVideo },
    selectors: [
      ...HEADING_SELECTORS,
      TABLE_SELECTOR,
      { selector: 'img', format: 'kunImage' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'div[data-video-player]', format: 'kunVideo' }
    ]
  })
}

export const kunHtmlToText = (
  html: KunSafeHtml,
  mode: KunTextMode = 'display'
): string => converters[mode](html).replace(/\s+/g, ' ').trim()

// 按码点截断, 不劈开代理对; 长度由调用点按产品需要决定
export const kunExcerpt = (text: string, maxCodePoints: number) =>
  sliceCodePoints(text, maxCodePoints)

// 拿不到已净化 HTML 时的诚实回退: 只折叠空白并截断, 不重新解释 markdown 语法,
// 读者看到的是带语法标记的全部字符, 不会被吞字
export const kunRawExcerpt = (source: string, maxCodePoints: number) =>
  sliceCodePoints(source.replace(/\s+/g, ' ').trim(), maxCodePoints)
