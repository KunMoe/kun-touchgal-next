import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Next 16.3 的 useRouter() 为读 bfcacheId 订阅了 LayoutRouterContext, @bprogress/next/app
// 的 useRouter 内部也调用它: 任何 URL 变化 (含 history.replaceState 只改 query) 都让
// 每个调用方同步重渲染. 列表项一页几十个, /[id] 从讨论版点走一次 tab 就要同步重渲染
// 约 2000 个组件. 列表项必须改从根部 KunRouterProvider 取稳定实例
const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

const ROUTER_IMPORT =
  /import \{[^}]*\buseRouter\b[^}]*\} from '(?:@bprogress\/next\/app|next\/navigation)'/

describe('列表项使用稳定的 router 实例', () => {
  it.each([
    ['../floating-card/KunUser.tsx', 'useKunRouter()'],
    ['../floating-card/KunAvatar.tsx', 'useKunRouter()'],
    ['../../patch/resource/Tabs.tsx', 'useKunNextRouter()']
  ])('%s', (file, hook) => {
    const source = readSource(file)
    expect(source).not.toMatch(ROUTER_IMPORT)
    expect(source).toContain(hook)
  })

  // bprogress 的 useRouter 依赖 ProgressProvider 的 context
  it('KunRouterProvider 挂在 ProgressProvider 之内', () => {
    const source = readSource('../../../app/providers.tsx')
    expect(source.indexOf('<ProgressProvider')).toBeGreaterThanOrEqual(0)
    expect(source.indexOf('<KunRouterProvider>')).toBeGreaterThan(
      source.indexOf('<ProgressProvider')
    )
    expect(source.indexOf('</KunRouterProvider>')).toBeLessThan(
      source.indexOf('</ProgressProvider>')
    )
  })
})
