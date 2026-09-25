import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 登录态 /[id] 简介一次渲染 20-165 个标签 (按浏览量加权中位 40).
// 整对象订阅 user 时, 会话就绪的 setUser 会同步重渲染整表 (165 个标签 890 个组件);
// 每个标签包 HeroUI Tooltip 时, 水合后 useIsSSR 翻转会再同步重渲染一遍.
// 两者合计移动端 4x TBT +8.5 / +24 / +70ms (40 / 87 / 165 个标签)
const source = readFileSync(
  fileURLToPath(new URL('../Tag.tsx', import.meta.url)),
  'utf-8'
)

describe('PatchTag 渲染开销', () => {
  it('不订阅整个 user 对象', () => {
    expect(source).not.toMatch(/useUserStore\(\s*\)/)
    expect(source).not.toMatch(/=>\s*\w+\.user\s*\)/)
  })

  it('标签不包 HeroUI Tooltip', () => {
    expect(source).not.toMatch(/from '@heroui\/tooltip'/)
  })
})
