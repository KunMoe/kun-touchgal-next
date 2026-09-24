import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 资源详情页首屏曾是最重的公开路由 (549KB gz): 仅上传者 / 管理员可用的编辑
// 表单带入 zod 全量 / RHF / Select / 上传, 游客看不到的评论区也整块下发.
// 两者改为 next/dynamic 后首屏 34 块 → 25 块, −196KB gz (−35.8%).
// 任何一处退回静态导入, Turbopack 都会把整组块重新挂回页面入口
const source = readFileSync(
  fileURLToPath(new URL('../ResourceDetail.tsx', import.meta.url)),
  'utf-8'
)

const lazyModules = [
  '~/components/patch/resource/edit/EditResourceDialog',
  '~/components/patch/comment/Comments'
]

const dynamicBlocks = [
  ...source.matchAll(/^const \w+ = dynamic\(([\s\S]*?)^\)$/gm)
].map((match) => match[1])

describe('ResourceDetail 按需加载编辑弹窗与评论区', () => {
  it.each(lazyModules)('不静态导入 %s', (module) => {
    const name = module.split('/').pop()
    expect(source).not.toMatch(new RegExp(`from '[^']*/${name}'`))
  })

  it.each(lazyModules)('%s 经 next/dynamic 加载', (module) => {
    expect(
      dynamicBlocks.some((block) => block.includes(`import('${module}')`))
    ).toBe(true)
  })

  // ssr:true 且无 loading 时 next/dynamic 不包 Suspense, 评论块未到会挂起外层
  // 边界, 拖住整个详情页的水合
  it('评论区的 dynamic 带 loading', () => {
    const block = dynamicBlocks.find((block) =>
      block.includes("import('~/components/patch/comment/Comments')")
    )
    expect(block).toMatch(/\bloading:/)
  })
})
