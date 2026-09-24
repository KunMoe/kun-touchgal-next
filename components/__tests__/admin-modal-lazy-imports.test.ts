import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 标签 / 会社的创建与编辑弹窗只有管理员用得到, 却连带 zod 全量 / RHF / Select.
// 静态导入时 Turbopack 把整组块挂进页面入口, 每位访客首屏多下 14-131KB gz
// (/company -27%, /tag/[id] 与 /company/[id] -22%). 任何一处退回静态导入都会复发
const cases = [
  ['../tag/TagHeader.tsx', '~/components/tag/CreateTagModal'],
  ['../tag/detail/Container.tsx', './EditTagModal'],
  ['../company/CompanyHeader.tsx', './form/CompanyFormModal'],
  ['../company/detail/Container.tsx', '../form/CompanyFormModal']
]

const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

const dynamicBlocks = (source: string) =>
  [...source.matchAll(/^const \w+ = dynamic\(([\s\S]*?)^\)$/gm)].map(
    (match) => match[1]
  )

describe('管理员弹窗按需加载', () => {
  it.each(cases)('%s 不静态导入 %s', (file, module) => {
    const name = module.split('/').pop()
    expect(readSource(file)).not.toMatch(new RegExp(`from '[^']*/${name}'`))
  })

  it.each(cases)('%s 经 next/dynamic 加载 %s', (file, module) => {
    expect(
      dynamicBlocks(readSource(file)).some((block) =>
        block.includes(`import('${module}')`)
      )
    ).toBe(true)
  })
})
