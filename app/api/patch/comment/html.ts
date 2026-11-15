import { COMMENT_HTML_VERSION } from '~/app/api/utils/render/markdownToHtmlComment'
import type { KunSafeHtml } from '~/types/content'

// 落库的 content_html 是渲染管线当时的产物, 版本与当前管线一致才可信。版本落后或
// 为空时返回 null, 由调用方决定是重渲染 (评论分页) 还是退回原文摘要 (各类列表)。
// 这里不渲染、不抛错, 所以列表路径不会被一条渲染失败的评论拖垮
export const readStoredCommentHtml = (row: {
  content_html: string
  content_html_version: number
}): KunSafeHtml | null =>
  row.content_html_version === COMMENT_HTML_VERSION && row.content_html
    ? (row.content_html as KunSafeHtml)
    : null
