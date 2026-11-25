import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deriveTopBarView } from '~/components/kun/top-bar/topBarView'
import type { KunTopBarDropdownState } from '~/components/kun/top-bar/topBarView'

// UserDropdown 连带 Dropdown / Menu / Popover / Modal / Avatar 只对登录用户渲染,
// 静态导入会把约 45KB gz 塞进根布局入口, 游客每一页都下载. 但也不能改成 next/dynamic:
// 会话翻转由 zustand 的 useSyncExternalStore 驱动, 恒为同步 lane, startTransition
// 包不了, React 19 会把 Suspense 揭示推迟到 fallback 后 300ms, 登录用户每次硬加载
// 头像都比铃铛晚约 305ms (预热只省字节, 绕不开节流). 所以渲染直接读模块缓存、不经
// Suspense, 已登录而块没到齐时顶栏整块保持骨架 (deriveTopBarView), 到齐后铃铛与头像同帧
const userSource = readFileSync(
  fileURLToPath(new URL('../User.tsx', import.meta.url)),
  'utf-8'
)

const USER_DROPDOWN_IMPORT = "import('./UserDropdown')"

describe('顶栏 UserDropdown 按需加载且不经 Suspense', () => {
  it('User.tsx 不静态导入 UserDropdown, 也不用 next/dynamic', () => {
    expect(userSource).not.toContain("from './UserDropdown'")
    expect(userSource).not.toContain("from 'next/dynamic'")
  })

  it('UserDropdown 只有一处 import(), 位于共用 loader', () => {
    expect(userSource.split(USER_DROPDOWN_IMPORT)).toHaveLength(2)
    expect(userSource).toContain(
      `const loadUserDropdown = () => ${USER_DROPDOWN_IMPORT}`
    )
  })

  // S2b 之前是「两条会话路径都等块到齐后才写 store」, 按 uid 门控的请求因此被懒块拖住
  // (冷缓存约 206ms)。现在写入不等块, 同帧由视图保证: 已登录而块没到齐时整块骨架
  it('已登录而块没到齐时整块骨架, 到齐后铃铛与头像同一帧出现', () => {
    const view = (dropdown: KunTopBarDropdownState) =>
      deriveTopBarView({
        isMounted: true,
        isSessionPending: false,
        status: 'authenticated',
        dropdown
      })
    expect(view('loading')).toBe('skeleton')
    expect(view('ready')).toBe('user')
    // 铃铛与头像都只在 'user' 视图里渲染, 视图拿的是模块缓存的真实状态
    expect(userSource).toMatch(
      /dropdown:\s*dropdownModule\s*\?\s*'ready'\s*:\s*dropdownFailed\s*\?\s*'failed'\s*:\s*'loading'/
    )
    expect(userSource.match(/view === 'user'/g)).toHaveLength(1)
  })

  it('游客不加载块: 缺会话路径判定为游客之后才开始加载, 补加载只对已登录身份', () => {
    const guestExit = userSource.indexOf('markKunSessionGuest()')
    const loads = [
      ...userSource.matchAll(/void ensureUserDropdownModule\(\)/g)
    ].map((match) => match.index)
    // 首屏会话路径一处 (只在 initialSession 存在时运行)、缺会话路径一处、补加载一处
    expect(loads).toHaveLength(3)
    expect(guestExit).toBeGreaterThan(loads[0])
    expect(loads[1]).toBeGreaterThan(guestExit)
    expect(userSource).toMatch(
      /if \(status !== 'authenticated' \|\| dropdownModule\) \{\s*return\s*\}\s*void ensureUserDropdownModule\(\)/
    )
  })

  it('渲染直接读模块缓存', () => {
    expect(userSource).toMatch(
      /useSyncExternalStore\(\s*subscribeUserDropdown,\s*getUserDropdownModule,\s*getServerUserDropdownModule\s*\)/
    )
    expect(userSource).toContain('<dropdownModule.UserDropdown />')
  })
})
