import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 资源卡片的按压缩放曾用 ResourceTabs 顶层 state 记录按下的卡片: 按下 / 抬起,
// 以及从卡片上起手的触屏滑动 (pointerdown / pointercancel), 都会让当前分区整张
// 列表各重渲染一次, 37 张卡在 4x CPU 下每次约 89ms, 改为直接写卡片 DOM 属性后约 7ms.
// 也不要换成 CSS :active: 触屏上会变成松手后才缩, 按住修饰键按压也会缩
const source = readFileSync(
  fileURLToPath(new URL('../Tabs.tsx', import.meta.url)),
  'utf-8'
)

describe('资源卡片按压态不走 React state', () => {
  it('不用 useState 记录按下的卡片', () => {
    expect(source).not.toMatch(
      /\[\s*\w*pressed\w*\s*,\s*set\w+\s*\]\s*=\s*useState/i
    )
  })

  it('按压缩放由 data-pressed 属性驱动', () => {
    expect(source).toContain('data-[pressed]:scale-[0.99]')
  })

  it('只在会触发整卡导航的按下时置位, 抬起 / 离开 / 取消时清除', () => {
    expect(source).toMatch(
      /onPointerDown=\{\(event\) => \{\s*if \(!isNavigationBlocked\(event\)\) \{\s*event\.currentTarget\.setAttribute\('data-pressed', ''\)/
    )
    for (const handler of [
      'onPointerUp',
      'onPointerLeave',
      'onPointerCancel'
    ]) {
      expect(source).toContain(`${handler}={clearPressed}`)
    }
  })
})
