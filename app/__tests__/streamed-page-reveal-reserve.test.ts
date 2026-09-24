import { createElement, Suspense } from 'react'
import { renderToReadableStream } from 'react-dom/server'
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// 页面级 <Suspense> 在流式 SSR 中总被外置 (<div hidden id="S:N"> + 内联 $RC 揭示), shell
// 若先于揭示绘制, 高列表出现时会把页脚推下去. 修法是包裹层只在占位 <template> 仍为其
// 直接子节点时预留整屏高度; 这依赖 React Fizz 的占位形态, 升级 React 后须由本测试把关
const RESERVE_CLASS = 'w-full has-[>template]:min-h-dvh'

describe('长列表页在外置边界揭示前预留高度', () => {
  it.each(['app/galgame/page.tsx', 'app/resource/page.tsx'])(
    '%s 用预留包裹层包住页面 Suspense',
    (file) => {
      const source = readFileSync(file, 'utf8')
      expect(source).toContain(
        `<div className="${RESERVE_CLASS}">\n      <Suspense>`
      )
    }
  )

  it('React 把未揭示的外置边界输出为包裹层的直接子 <template>', async () => {
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
        createElement(
          'div',
          { className: RESERVE_CLASS },
          createElement(Suspense, null, list)
        ),
        createElement('footer', null, 'footer')
      )
    )
    await stream.allReady
    const html = await new Response(stream).text()

    expect(html).toContain(
      `<div class="${RESERVE_CLASS.replace('>', '&gt;')}"><!--$?--><template id="B:`
    )
    expect(html).toContain('<div hidden id="S:')
  })
})
