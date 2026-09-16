import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { kunMetadata as applyPendingMetadata } from '~/app/apply/pending/metadata'
import { kunMetadata as applySuccessMetadata } from '~/app/apply/success/metadata'
import { kunMetadata as redirectMetadata } from '~/app/redirect/metadata'

const APP_DIR = fileURLToPath(new URL('../', import.meta.url))

// 流程结果页没有独立搜索价值, canonical 刻意归一到父级路由
const CANONICAL_OVERRIDES: Record<string, string> = {
  'apply/success': '/apply',
  'apply/pending': '/apply'
}

const CANONICAL_RE = /canonical:\s*`\$\{kunMoyuMoe\.domain\.main\}([^`]*)`/
const TITLE_RE = /\btitle:\s*(['`])((?:\\.|(?!\1).)*)\1/g

// 动态路由段的 canonical 与标题都来自运行时数据, 无法静态比对
const staticMetadataFiles = readdirSync(APP_DIR, {
  recursive: true,
  encoding: 'utf-8'
}).filter((entry) => entry.endsWith('metadata.ts') && !entry.includes('['))

const pages = staticMetadataFiles.map((entry) => ({
  route: entry.replace(/\/?metadata\.ts$/, ''),
  source: readFileSync(join(APP_DIR, entry), 'utf-8')
}))

const canonicalPages = pages
  .map((page) => ({
    route: page.route,
    canonical: CANONICAL_RE.exec(page.source)?.[1]
  }))
  .filter((page) => page.canonical !== undefined)

const titlePages = pages
  .map((page) => ({
    route: page.route,
    titles: [...page.source.matchAll(TITLE_RE)].map((match) => match[2])
  }))
  .filter((page) => page.titles.length > 0)

describe('页面 metadata', () => {
  it('扫描到静态 metadata 文件', () => {
    expect(canonicalPages.length).toBeGreaterThan(20)
    expect(titlePages.length).toBeGreaterThan(20)
  })

  it.each(canonicalPages)('$route 的 canonical 指向自身路由', (page) => {
    expect(page.canonical).toBe(
      CANONICAL_OVERRIDES[page.route] ?? `/${page.route}`
    )
  })

  it.each(titlePages)('$route 的社交标题与页面标题一致', (page) => {
    expect(new Set(page.titles).size).toBe(1)
  })
})

describe('无独立搜索价值的页面标记 noindex', () => {
  it.each([
    ['redirect', redirectMetadata],
    ['apply/success', applySuccessMetadata],
    ['apply/pending', applyPendingMetadata]
  ])('%s', (_route, metadata) => {
    expect(metadata.robots).toEqual({ index: false })
  })
})
