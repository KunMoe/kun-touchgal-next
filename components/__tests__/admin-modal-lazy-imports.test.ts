import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 标签 / 会社的创建与编辑弹窗只有管理员用得到, 却连带 zod 全量 / RHF / Select.
// 静态导入时 Turbopack 把整组块挂进页面入口, 每位访客首屏多下 14-131KB gz
// (/company -27%, /tag/[id] 与 /company/[id] -22%). 任何一处退回静态导入都会复发.
// /[id] 的标签 / 会社选择器同理 (Input / Checkbox / ScrollShadow, -18.9KB gz)
const cases = [
  ['../tag/TagHeader.tsx', '~/components/tag/CreateTagModal'],
  ['../tag/detail/Container.tsx', './EditTagModal'],
  ['../company/CompanyHeader.tsx', './form/CompanyFormModal'],
  ['../company/detail/Container.tsx', '../form/CompanyFormModal'],
  ['../patch/introduction/Tag.tsx', './PatchTagSelector'],
  ['../patch/introduction/Company.tsx', './PatchCompanySelector']
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

  // 没有 ssr: false (也没 loading) 时 next/dynamic 不包 Suspense,
  // 角色翻转挂载时会挂起到上层边界, 把整块内容换成兜底
  it.each(cases)('%s 加载 %s 时带 ssr: false', (file, module) => {
    expect(
      dynamicBlocks(readSource(file)).some(
        (block) =>
          block.includes(`import('${module}')`) && block.includes('ssr: false')
      )
    ).toBe(true)
  })
})
