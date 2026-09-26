import { createElement } from 'react'
import { renderToReadableStream } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CustomMDX } from '~/lib/mdx/CustomMDX'
import { extractKunHeadings } from '~/lib/mdx/extractHeadings'
import { getAllPosts, getPostBySlug } from '~/lib/mdx/getPosts'

// 目录在构建期用 remark 从源码提取, 正文由 MDX 渲染, 两边各自算标题 id;
// 对不上时目录链接跳空, IntersectionObserver 也找不到标题。
// 必须连 text 一起比: 正则提取 `### **粗体**` 时 id 仍一致 (slugify 会删掉 *), 只有文本会带出 **
const decodeHtml = (html: string) =>
  html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')

const renderHeadings = async (source: string) => {
  const stream = await renderToReadableStream(
    createElement(CustomMDX, { source })
  )
  await stream.allReady
  const html = await new Response(stream).text()

  return Array.from(
    html.matchAll(/<h([1-3])\b([^>]*)>([\s\S]*?)<\/h\1>/g),
    ([, level, attributes, inner]) => ({
      id: /\bid="([^"]*)"/.exec(attributes)?.[1] ?? '',
      text: decodeHtml(
        inner
          .replace(/<a\b[^>]*class="kun-anchor"[^>]*>[\s\S]*?<\/a>/g, '')
          .replace(/<[^>]+>/g, '')
      ),
      level: Number(level)
    })
  ).filter((heading) => heading.id && heading.text)
}

describe('extractKunHeadings 与 CustomMDX 渲染的标题一致', () => {
  it.each(getAllPosts().map((post) => post.slug))('%s', async (slug) => {
    const { content } = getPostBySlug(slug)
    expect(extractKunHeadings(content)).toEqual(await renderHeadings(content))
  })

  it('文本不含 markdown 标记, 只取 h1-h3', () => {
    expect(extractKunHeadings('### **下载慢？**\n\n#### 四级标题\n')).toEqual([
      { id: '下载慢', text: '下载慢？', level: 3 }
    ])
  })
})
