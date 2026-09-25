import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { cn } from '~/utils/cn'

describe('cn 认识 HeroUI 的自定义类', () => {
  // components/resource/ResourceCard.tsx 与两个提及下拉框的真实写法
  it.each([
    ['text-small', 'line-clamp-2 text-small leading-5 text-default-500'],
    [
      'border-small',
      'bg-background border-small rounded-small border-default-200 dark:border-default-100'
    ]
  ])('与颜色类同用时保留 %s', (_, input) => {
    expect(cn(input)).toBe(input)
  })

  it('自定义类仍按所属类组合并', () => {
    expect(cn('text-small', 'text-tiny')).toBe('text-tiny')
    expect(cn('border-small', 'border-2')).toBe('border-2')
    expect(cn('shadow-small', 'shadow-lg')).toBe('shadow-lg')
  })
})

// @heroui/theme 与 tailwind-variants 把 tailwind-merge 钉死在旧版本, 与应用自己的版本各打一份进根布局 (~7KB gz);
// pnpm-workspace.yaml 用 overrides 把两者对齐到应用的版本. 升级 HeroUI 或 tailwind-merge 后这里变红, 须同步 overrides
describe('pnpm-lock.yaml 只有一份 tailwind-merge', () => {
  it('所有依赖解析到同一个版本', () => {
    const lockfile = readFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'utf8')
    const versions = new Set(
      [...lockfile.matchAll(/^ {2}tailwind-merge@([^:\s]+):/gm)].map(
        (match) => match[1]
      )
    )
    expect([...versions]).toHaveLength(1)
  })
})
