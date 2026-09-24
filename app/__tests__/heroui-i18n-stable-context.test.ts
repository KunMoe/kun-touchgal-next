import { createRequire } from 'module'
import { readFileSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'

// HeroUIProvider 内置 @react-aria/i18n@3.12.10 的 I18nProvider, 其 useMemo 依赖
// [defaultLocale, locale]; useDefaultLocale 在 isSSR 阶段每次返回新字面量, 水合后
// useIsSSR 以 SyncLane 翻转 → context 换引用 → 页面级无 fallback <Suspense> 若仍
// 脱水 (页面 chunk 晚到) 会被 React 丢弃服务端 DOM 改为客户端重建 (/galgame 移动
// CLS 0.276). patches/@react-aria__i18n@3.12.10.patch 把依赖改为只在无 locale 时
// 看 defaultLocale, 与上游 react-aria 3.50 的 I18nProviderWithLocale 语义一致
const resolveHeroUII18nRoot = () => {
  const require = createRequire(import.meta.url)
  const system = realpathSync(require.resolve('@heroui/system/package.json'))
  const entry = realpathSync(createRequire(system).resolve('@react-aria/i18n'))
  return dirname(dirname(entry))
}

describe('HeroUIProvider 的 I18nProvider context 水合前后引用稳定', () => {
  const root = resolveHeroUII18nRoot()

  it('HeroUI 解析到的仍是被 patch 的 3.12.10', () => {
    const { version } = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8')
    )
    // 版本变了 (升级 HeroUI / 依赖去重) 须重新评估: 上游已修则删 patch, 否则重做
    expect(version).toBe('3.12.10')
  })

  it.each(['context.mjs', 'context.module.js', 'context.main.js'])(
    'dist/%s 的 memo 依赖不含无条件的 defaultLocale',
    (file) => {
      const source = readFileSync(join(root, 'dist', file), 'utf8')
      expect(source).not.toMatch(/\[\s*defaultLocale,\s*locale\s*\]/)
      expect(source).toMatch(
        /\[\s*locale \? null : defaultLocale,\s*locale\s*\]/
      )
    }
  )
})
