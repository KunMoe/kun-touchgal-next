import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chip } from '@heroui/theme'
import { describe, expect, it } from 'vitest'
import {
  KUN_STATIC_CHIP_COLOR_CLASS,
  KUN_STATIC_CHIP_SIZE_CLASS,
  KunStaticChip
} from '../StaticChip'
import type { KunStaticChipColor, KunStaticChipSize } from '../StaticChip'

// C34: 列表卡片的徽章从 HeroUI Chip 换成静态 span 后, 类名逐字取自
// @heroui/theme 的 chip({ variant: 'flat' }) 输出。升级 HeroUI 改了色板或尺寸
// token 时这里会红, 届时同步更新 StaticChip 的表而不是放宽断言
const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf-8')

// createElement 的 children 必须走第三个参数 (react/no-children-prop), 断言绕过必填校验
type ChipProps = ComponentProps<typeof KunStaticChip>

const colors = Object.keys(KUN_STATIC_CHIP_COLOR_CLASS) as KunStaticChipColor[]
const sizes = Object.keys(KUN_STATIC_CHIP_SIZE_CLASS) as KunStaticChipSize[]

const tokens = (classNames: string) => classNames.split(' ').filter(Boolean)

const paddingX = (classNames: string) =>
  Number(
    tokens(classNames)
      .find((token) => /^px-\d+$/.test(token))
      ?.slice(3)
  )

describe('KunStaticChip 与 HeroUI flat Chip 的色板一致', () => {
  it.each(colors)('%s 的颜色 token 与 chip() 输出逐一相同', (color) => {
    const slots = chip({ variant: 'flat', color, size: 'sm' })
    const heroColorTokens = tokens(slots.base()).filter((token) =>
      /^(bg-|text-[a-z]+-\d|dark:)/.test(token)
    )

    expect(tokens(KUN_STATIC_CHIP_COLOR_CLASS[color]).sort()).toEqual(
      heroColorTokens.sort()
    )
  })
})

describe('KunStaticChip 与 HeroUI flat Chip 的尺寸一致', () => {
  it.each(sizes)('%s 的高度、字号与合并后的水平内边距相同', (size) => {
    const slots = chip({ variant: 'flat', color: 'primary', size })
    const base = slots.base()
    const height = tokens(base).find((token) => /^h-\d+$/.test(token))
    const fontSize = tokens(base).find((token) =>
      /^text-(tiny|small|medium|large)$/.test(token)
    )
    // HeroUI 是 base 与 content 两层 padding, 静态版单层, 数值相加
    const mergedPaddingX = paddingX(base) + paddingX(slots.content())

    expect(KUN_STATIC_CHIP_SIZE_CLASS[size]).toBe(
      `${height} px-${mergedPaddingX} ${fontSize}`
    )
  })
})

describe('KunStaticChip 渲染', () => {
  it('输出单个 span, 默认 md / default, 附加 className 追加在末尾', () => {
    const html = renderToStaticMarkup(
      createElement(
        KunStaticChip,
        { size: 'sm', color: 'primary', className: 'shrink-0' } as ChipProps,
        '简体中文'
      )
    )

    expect(html).toBe(
      '<span class="inline-flex max-w-fit min-w-min items-center whitespace-nowrap rounded-full font-normal h-6 px-2 text-tiny bg-primary/20 text-primary-600 shrink-0">简体中文</span>'
    )
    expect(
      renderToStaticMarkup(
        createElement(KunStaticChip, {} as ChipProps, '1.2 GB')
      )
    ).toContain('h-7 px-3 text-small bg-default/40 text-default-700"')
  })
})

describe('列表卡片的徽章不再使用 HeroUI Chip', () => {
  it.each([
    '../PatchAttribute.tsx',
    '../../resource/ResourceCard.tsx',
    '../../company/Card.tsx'
  ])('%s 不导入 @heroui/chip', (relativePath) => {
    expect(readSource(relativePath)).not.toContain('@heroui/chip')
  })
})
