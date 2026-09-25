import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 高级筛选面板默认收起, 静态导入 @heroui/select 会把 Select / Listbox / 虚拟列表
// 约 22KB gz 打进 /galgame、/search、/tag/[id]、/company/[id] 的首屏入口.
// 退回静态导入、拆开 import() 或去掉 startTransition 都会复发
const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

const filterBar = readSource('../FilterBar.tsx')
const panel = readSource('../AdvancedFilterPanel.tsx')

describe('高级筛选面板按需加载', () => {
  it('FilterBar 不静态导入 @heroui/select 与面板模块', () => {
    expect(filterBar).not.toMatch(/from '@heroui\/select'/)
    expect(filterBar).not.toMatch(
      /^import (?!type ).*from '\.\/AdvancedFilterPanel'/m
    )
  })

  it('FilterBar 经 next/dynamic 与共用的 import() 加载面板', () => {
    expect(filterBar).toMatch(/from 'next\/dynamic'/)
    expect(filterBar).toContain(
      "const loadAdvancedFilterPanel = () => import('./AdvancedFilterPanel')"
    )
    expect(filterBar).toMatch(/dynamic\(\s*\(\) => loadAdvancedFilterPanel\(\)/)
    expect(filterBar).toMatch(/void loadAdvancedFilterPanel\(\)/)
  })

  it('面板挂载放在 startTransition 里', () => {
    expect(filterBar).toMatch(
      /startTransition\(\(\) => \{\s*setShowAdvancedFilters\(/
    )
  })

  it('Select 只在面板模块里', () => {
    expect(panel).toMatch(/from '@heroui\/select'/)
  })
})
