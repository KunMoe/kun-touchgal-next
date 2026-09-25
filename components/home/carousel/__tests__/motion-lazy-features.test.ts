import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// 完整版 motion 等于预加载 animations + gestures + drag + layout, 会把 drag+layout
// (14.3KB gz) 与 domAnimation (17.3KB gz) 两个特性块静态放进首页入口, 整页水合都要
// 等它们到齐。轮播必须用 m + 异步 LazyMotion, 让特性在水合后再加载
const carouselDir = join(__dirname, '..')
const carouselSource = readFileSync(
  join(carouselDir, 'KunCarousel.tsx'),
  'utf8'
)

const importFromFramer = (source: string) =>
  [
    ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'framer-motion'/g)
  ].flatMap((match) => match[1].split(',').map((name) => name.trim()))

describe('KunCarousel 的 framer-motion 特性按需加载', () => {
  it('只导入 m, 不导入完整版 motion', () => {
    const names = importFromFramer(carouselSource)
    expect(names).toContain('m')
    expect(names).toContain('LazyMotion')
    expect(names).not.toContain('motion')
    expect(carouselSource).not.toMatch(/<motion\./)
  })

  it('LazyMotion 的 features 是异步 loader, 走 ~/motion/features-max', () => {
    expect(carouselSource).toMatch(
      /<LazyMotion\s+features=\{loadMotionFeatures\}/
    )
    expect(carouselSource).toMatch(
      /const loadMotionFeatures = \(\) =>\s*import\('~\/motion\/features-max'\)/
    )
  })

  it('轮播目录没有静态导入 domMax / domAnimation', () => {
    const sources = readdirSync(carouselDir)
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => readFileSync(join(carouselDir, file), 'utf8'))
    for (const source of sources) {
      expect(importFromFramer(source)).not.toContain('domMax')
      expect(importFromFramer(source)).not.toContain('domAnimation')
      expect(source).not.toMatch(/@heroui\/dom-animation/)
    }
  })
})
