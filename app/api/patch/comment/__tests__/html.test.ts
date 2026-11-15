import { describe, expect, it } from 'vitest'
import { COMMENT_HTML_VERSION } from '~/app/api/utils/render/markdownToHtmlComment'
import { readStoredCommentHtml } from '~/app/api/patch/comment/html'

describe('readStoredCommentHtml', () => {
  it('版本与当前渲染管线一致时返回落库的 HTML', () => {
    expect(
      readStoredCommentHtml({
        content_html: '<p>comment</p>',
        content_html_version: COMMENT_HTML_VERSION
      })
    ).toBe('<p>comment</p>')
  })

  it('版本落后时返回 null, 交给调用方决定重渲染还是退回原文', () => {
    expect(
      readStoredCommentHtml({
        content_html: '<p>stale</p>',
        content_html_version: COMMENT_HTML_VERSION - 1
      })
    ).toBeNull()
  })

  // 写入时渲染失败的评论落库为空 HTML + version 0
  it('HTML 为空时返回 null', () => {
    expect(
      readStoredCommentHtml({
        content_html: '',
        content_html_version: COMMENT_HTML_VERSION
      })
    ).toBeNull()
    expect(
      readStoredCommentHtml({ content_html: '', content_html_version: 0 })
    ).toBeNull()
  })
})
