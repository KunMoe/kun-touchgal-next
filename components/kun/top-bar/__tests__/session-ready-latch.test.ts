import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 顶栏骨架只等首次判定访客身份. 根布局在软导航里不重渲染, initialSession 一直是整页加载时
// 的值: 曾用 user.uid === initialSession.user.uid 当就绪, 站内登出后 uid 归 0 就永远不等;
// cookie 失效而 localStorage 还留着用户时, 复查 401 的分支登出跳转后没有置就绪. 两处都是
// 骨架一直转、刷新才恢复. 就绪必须是判定的每个出口都置真、之后不再回落的锁存
const userSource = readFileSync(
  fileURLToPath(new URL('../User.tsx', import.meta.url)),
  'utf-8'
)

describe('顶栏会话就绪是只置真一次的锁存', () => {
  it('就绪是初值 false 的状态, 只会被置真', () => {
    expect(userSource).toContain(
      'const [isSessionReady, setIsSessionReady] = useState(false)'
    )
    const writes = userSource.match(/setIsSessionReady\([^)]*\)/g) ?? []
    expect(writes.length).toBeGreaterThan(0)
    expect(new Set(writes)).toEqual(new Set(['setIsSessionReady(true)']))
  })

  it('就绪不由 store 里的 user 与 initialSession 比对得出', () => {
    expect(userSource).not.toContain('initialSession.user.uid')
  })

  it('复查判定会话失效的分支登出后先置就绪再跳登录页', () => {
    expect(userSource).toMatch(
      /logout\(\)\s*resetUnreadMessageStatus\(\)\s*resetSettings\(\)\s*setIsSessionReady\(true\)\s*router\.push\(/
    )
  })
})
