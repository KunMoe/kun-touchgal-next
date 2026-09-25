import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// C40: 组件里 import 的全局样式表会被拆成路由专属的阻塞 CSS, 且客户端导航后
// 不会卸载。/[id] 简介曾经就这样引入 .kun-prose h2 的改写, 导航到 /doc 后文档
// 标题也被改掉。全局样式只能从根布局的 styles/index.css 进入, 局部差异改用
// 显式修饰类 (如 kun-prose-compact); CSS Modules 的类名带哈希, 不会泄漏
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

// 跳过隐藏目录 (.next、.claude 下有整仓副本)、依赖和被 gitignore 的 docs
const listSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      return []
    }
    if (entry.isDirectory()) {
      return path === join(repoRoot, 'docs') || entry.name === '__tests__'
        ? []
        : listSourceFiles(path)
    }
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

const sourceFiles = listSourceFiles(repoRoot).map((file) => ({
  path: relative(repoRoot, file),
  source: readFileSync(file, 'utf-8')
}))

const STYLESHEET_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+\.(?:css|scss|sass|less))['"]/g

describe('本地全局样式表只从根布局进入', () => {
  it('除 app/layout.tsx 引入 ~/styles/index.css 外, 不 import 本地非模块样式表', () => {
    const imports = sourceFiles.flatMap(({ path, source }) =>
      [...source.matchAll(STYLESHEET_IMPORT)]
        .map((match) => match[1])
        .filter((spec) => /^(?:\.|~\/|\/)/.test(spec))
        .filter((spec) => !/\.module\.\w+$/.test(spec))
        .map((spec) => `${path} -> ${spec}`)
    )

    expect(imports).toEqual(['app/layout.tsx -> ~/styles/index.css'])
  })

  // 文档页按 DESIGN.md 用默认 h2 (700 + 顶部分隔线); 其余 kun-prose 渲染的都是
  // 嵌入卡片的用户内容 (简介/评论/资源备注/评论预览), 以 h2 开头时须去掉顶部留白
  it('除文档页外, 所有 kun-prose 容器都带 kun-prose-compact', () => {
    const missing = sourceFiles.flatMap(({ path, source }) =>
      path === join('app', 'doc', '[...slug]', 'page.tsx')
        ? []
        : source
            .split('\n')
            .filter((line) => /\bkun-prose(?![-\w])/.test(line))
            .filter((line) => !line.includes('kun-prose-compact'))
            .map((line) => `${path}: ${line.trim()}`)
    )

    expect(missing).toEqual([])
  })
})
