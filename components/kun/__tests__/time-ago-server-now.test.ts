import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KunNowProvider } from '../KunNowProvider'
import { KunTimeAgo } from '../TimeAgo'

// C52: SSR 曾先输出绝对时间、挂载后再换成相对时间, /resource 窄屏卡片描述两行变一行,
// CLS 0.07。现在 SSR 与水合首帧都按根布局下发的服务端 now 计算相对时间, 两边文本逐字相同。
// SSR 若退回绝对时间, 或改读本机时钟 (服务端与浏览器时钟不同步就会 hydration mismatch), 这里会红
const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf-8')

const DAY_MS = 24 * 60 * 60 * 1000
const SERVER_NOW = Date.UTC(2026, 8, 26, 4, 0, 0)

// createElement 的 children 必须走第三个参数 (react/no-children-prop), 断言绕过必填校验
const renderAtServerNow = (date: number, maxRelativeDays?: number) =>
  renderToStaticMarkup(
    createElement(
      KunNowProvider,
      { now: SERVER_NOW } as ComponentProps<typeof KunNowProvider>,
      createElement(KunTimeAgo, { date, maxRelativeDays })
    )
  )

describe('KunTimeAgo 的 SSR 输出只取决于服务端 now', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('SSR 直接输出相对时间, 且与本机时钟无关', () => {
    vi.useFakeTimers()
    vi.setSystemTime(SERVER_NOW + 3 * DAY_MS)

    expect(renderAtServerNow(SERVER_NOW - 8 * DAY_MS)).toBe('8 天前')
  })

  it('maxRelativeDays 按整天毫秒差判断, 不受时区夏令时影响', () => {
    expect(renderAtServerNow(SERVER_NOW - 8 * DAY_MS + 1, 7)).toBe('7 天前')
    expect(renderAtServerNow(SERVER_NOW - 8 * DAY_MS, 7)).toBe('2026-09-18')
  })

  it('根布局把请求时刻经 Providers 下发给 KunNowProvider', () => {
    const layout = readSource('../../../app/layout.tsx')
    expect(layout).toContain('const requestTime = Date.now()')
    expect(layout).toContain('<Providers now={requestTime}>')
    expect(readSource('../../../app/providers.tsx')).toContain(
      '<KunNowProvider now={now}>'
    )
  })
})
