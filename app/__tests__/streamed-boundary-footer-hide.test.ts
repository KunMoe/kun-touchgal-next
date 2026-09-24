import { createElement, Suspense } from 'react'
import { renderToReadableStream } from 'react-dom/server'
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// 页面级 <Suspense> 在流式 SSR 中总被外置 (<div hidden id="S:N"> + 内联 $RC 揭示). 根布局
// 在内容区仍有未揭示占位 <template id="B:N"> 时隐藏其后的 <footer>, 长内容揭示时就不会
// 推动可见的页脚; 这依赖 React Fizz 的占位形态, 升级 React 后须由本测试把关
const HIDE_FOOTER_VARIANT = '[&:has(template[id^=B])~footer]:invisible'

describe('流式边界揭示前隐藏页脚', () => {
  it('根布局内容区带隐藏变体, 且页脚是其后续兄弟', () => {
    const layout = readFileSync('app/layout.tsx', 'utf8')
    const variantAt = layout.indexOf(HIDE_FOOTER_VARIANT)
    expect(variantAt).toBeGreaterThan(-1)
    expect(layout.indexOf('<KunFooter />')).toBeGreaterThan(variantAt)
    expect(readFileSync('components/kun/Footer.tsx', 'utf8')).toContain(
      '<footer'
    )
  })

  it('React 把未揭示的外置边界输出为 <template id="B:N"> 占位', async () => {
    const list = createElement(
      'ul',
      null,
      Array.from({ length: 400 }, (_, i) =>
        createElement('li', { key: i }, `item-${i}`.repeat(4))
      )
    )
    const stream = await renderToReadableStream(
      createElement(
        'main',
        null,
        createElement('div', null, createElement(Suspense, null, list))
      )
    )
    await stream.allReady
    const html = await new Response(stream).text()

    expect(html).toContain('<div><!--$?--><template id="B:')
    expect(html).toContain('<div hidden id="S:')
  })
})
