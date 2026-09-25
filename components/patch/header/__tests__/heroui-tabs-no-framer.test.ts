import { createRequire } from 'module'
import { readFileSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'

// @heroui/tabs@2.2.20 的 Tab 把选中底块写成 <LazyMotion features={domMax}><m.span layoutId="cursor"/>,
// 模块顶层静态引入 domMax, 让 /[id]、/user/[id]、/edit/create 的入口多带 drag+layout (14.3KB gz)
// 与 domAnimation (17.3KB gz) 两块; 而这个共享布局动画在本站从未生效 (主树与生产都是一帧跳变).
// patches/@heroui__tabs@2.2.20.patch 把底块换成纯 <span>, 类名与原来逐字相同.
// 升级 HeroUI 到 ≥2.8.5 (tabs ≥2.2.24, 上游已改为纯 CSS 定位的 cursor) 时: 删 patch、删本测试.
const resolveHeroUITabsRoot = () => {
  const require = createRequire(import.meta.url)
  const pkg = realpathSync(require.resolve('@heroui/tabs/package.json'))
  return dirname(pkg)
}

describe('@heroui/tabs 的选中底块不再静态引入 framer-motion 特性包', () => {
  const root = resolveHeroUITabsRoot()

  it('解析到的仍是被 patch 的 2.2.20', () => {
    const { version } = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8')
    )
    // 版本变了 (升级 HeroUI) 须重新评估: tabs ≥2.2.24 上游已无 framer cursor, 直接删 patch 与本测试
    expect(version).toBe('2.2.20')
  })

  it.each(['chunk-EVPGEU4E.mjs', 'tab.js'])(
    'Tab 所在的 dist/%s 完全不引用 framer-motion',
    (file) => {
      const source = readFileSync(join(root, 'dist', file), 'utf8')
      expect(source).not.toContain('"framer-motion"')
      expect(source).not.toContain('domMax')
      expect(source).not.toContain('LazyMotion')
      expect(source).not.toContain('layoutId')
      expect(source).toContain('"data-slot": "cursor"')
    }
  )

  // CJS 入口把 Tabs (LayoutGroup) 与 Tab 打在一个文件里, 只能断言 cursor 相关的特性包引用消失
  it.each(['index.js', 'tabs.js'])(
    'dist/%s 不再引用 domMax / LazyMotion',
    (file) => {
      const source = readFileSync(join(root, 'dist', file), 'utf8')
      expect(source).not.toContain('domMax')
      expect(source).not.toContain('LazyMotion')
      expect(source).toContain('"data-slot": "cursor"')
    }
  )
})
