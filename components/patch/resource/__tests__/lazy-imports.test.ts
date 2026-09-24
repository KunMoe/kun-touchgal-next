import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// /[id] 资源 tab 的懒加载组曾有 129.7KB gz, 其中约 118KB 是只有发布者 / 作者 /
// 管理员才用得到的表单 (zod / RHF / Select / 上传) 与只服务「补丁」分区的 DOMPurify,
// 每位访客都要等它们下完资源列表才出现. 拆出后该组 8 块 → 2 块, 11.2KB gz.
// 任何一处退回静态导入, Turbopack 都会把整组块重新并回资源 tab
const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

const resourceSource = readSource('../Resource.tsx')

const lazyForms = ['./publish/PublishResource', './edit/EditResourceDialog']

const dynamicBlocks = [
  ...resourceSource.matchAll(/^const \w+ = dynamic\(([\s\S]*?)^\)$/gm)
].map((match) => match[1])

describe('资源 tab 按需加载发布 / 编辑表单与 DOMPurify', () => {
  it.each(lazyForms)('Resource.tsx 不静态导入 %s', (module) => {
    const name = module.split('/').pop()
    expect(resourceSource).not.toMatch(new RegExp(`from '[^']*/${name}'`))
  })

  it.each(lazyForms)('Resource.tsx 经 next/dynamic 加载 %s', (module) => {
    expect(
      dynamicBlocks.some((block) => block.includes(`import('${module}')`))
    ).toBe(true)
  })

  it('KunResourceDownload 按需加载 DOMPurify 且仍做净化', () => {
    const source = readSource('../kun/KunResourceDownload.tsx')
    expect(source).not.toMatch(/from 'isomorphic-dompurify'/)
    expect(source).toContain("import('isomorphic-dompurify')")
    expect(source).toContain('DOMPurify.sanitize(')
  })
})
