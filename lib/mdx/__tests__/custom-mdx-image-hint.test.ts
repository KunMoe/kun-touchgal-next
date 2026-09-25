import { createElement } from 'react'
import { renderToReadableStream } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CustomMDX } from '~/lib/mdx/CustomMDX'

// React 对非 lazy、非 fetchPriority="low" 的 <img> 自动发 image preload:
// Fizz 写成 head 里的 <link rel="preload">, Flight 写成 :HL 提示, 两处判定条件相同。
// 后者会让 /doc 链接一被预取就下载整篇正文图 (月报目录侧栏一次近 2MB)
const src = 'https://example.com/uploads/doc.avif'

const render = async () => {
  const stream = await renderToReadableStream(
    createElement(
      'html',
      null,
      createElement('head'),
      createElement(
        'body',
        null,
        createElement(CustomMDX, { source: `![kun](${src})` })
      )
    )
  )
  await stream.allReady
  return new Response(stream).text()
}

describe('CustomMDX 正文图不发 image preload', () => {
  it('正文 img 带 fetchPriority="low"', async () => {
    const img = (await render()).match(/<img\b[^>]*>/)?.[0]
    expect(img).toContain(`src="${src}"`)
    expect(img).toContain('fetchPriority="low"')
  })

  it('不输出 image preload 链接', async () => {
    const html = await render()
    expect(html).toContain(`src="${src}"`)
    expect(html).not.toMatch(/<link\b[^>]*rel="preload"[^>]*as="image"/)
  })
})
