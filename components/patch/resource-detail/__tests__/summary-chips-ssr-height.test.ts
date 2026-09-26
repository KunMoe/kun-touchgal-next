import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GalgameSummaryCard } from '../GalgameSummaryCard'

// 类型 chip 的两行截断由 layout effect 在水合时才算出, SSR 首帧显示层是全量 chip;
// 显示层必须用 CSS 封顶到两行, 否则移动端水合时卡片变矮, 下方主列整体上移 32px/行
// (9-26 生产构建 390px 实测 CLS 0.029 / 0.057 → 0.001)
const galgame: GalgameCard = {
  id: 1,
  uniqueId: 'abcd1234',
  name: 'kun-galgame',
  banner: 'https://example.com/patch/1/banner/banner.avif',
  view: 1,
  download: 1,
  type: [
    'game',
    'manual',
    'ai',
    'machine_polishing',
    'save',
    'uncensored',
    'adult',
    'other'
  ],
  language: ['zh-Hans'],
  platform: ['windows'],
  created: '2026-01-01T00:00:00.000Z',
  _count: { favorite_folder: 0, resource: 0, comment: 0 }
}

const html = renderToString(createElement(GalgameSummaryCard, { galgame }))
const divs: string[] = html.match(/<div\b[^>]*>/g) ?? []
const classTokens = (tag: string) =>
  (tag.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/)
const spacingOf = (tokens: string[], prefix: string) => {
  const token = tokens.find((t) => new RegExp(`^${prefix}-\\d+$`).test(t))
  expect(token, `缺少 ${prefix}-* 类`).toBeDefined()
  return Number(token!.slice(prefix.length + 1))
}

const wrapLayers = divs.filter((tag) => classTokens(tag).includes('flex-wrap'))
const measureLayer = wrapLayers.find((tag) => tag.includes('aria-hidden'))
const visibleLayer = wrapLayers.find((tag) => !tag.includes('aria-hidden'))

describe('GalgameSummaryCard 类型 chip SSR 首帧与水合后等高', () => {
  it('SSR 有测量层与显示层', () => {
    expect(wrapLayers).toHaveLength(2)
    expect(measureLayer).toBeDefined()
    expect(visibleLayer).toBeDefined()
  })

  it('显示层封顶并裁掉溢出行', () => {
    const tokens = classTokens(visibleLayer!)
    expect(tokens).toContain('overflow-hidden')
    spacingOf(tokens, 'max-h')
  })

  it('测量层不封顶, 否则测不出溢出', () => {
    const tokens = classTokens(measureLayer!)
    expect(tokens.some((t) => t.startsWith('max-h-'))).toBe(false)
    expect(tokens).not.toContain('overflow-hidden')
  })

  // 封顶值与 chip 尺寸耦合: 改 Chip size 或升级 HeroUI 改了 sm 高度时同步调整 max-h
  it('max-h 恰为两行 chip 加一道行距', () => {
    const tokens = classTokens(visibleLayer!)
    const chip = divs[divs.indexOf(visibleLayer!) + 1]
    const chipHeight = spacingOf(classTokens(chip), 'h')
    expect(spacingOf(tokens, 'max-h')).toBe(
      chipHeight * 2 + spacingOf(tokens, 'gap')
    )
  })
})
