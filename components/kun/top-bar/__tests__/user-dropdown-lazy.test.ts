import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// UserDropdown 连带 Dropdown / Menu / Popover / Modal / Avatar 只对登录用户渲染,
// 静态导入会把约 45KB gz 塞进根布局入口, 游客每一页都下载. 但也不能改成 next/dynamic:
// 会话翻转由 zustand 的 useSyncExternalStore 驱动, 恒为同步 lane, startTransition
// 包不了, React 19 会把 Suspense 揭示推迟到 fallback 后 300ms, 登录用户每次硬加载
// 头像都比铃铛晚约 305ms (预热只省字节, 绕不开节流). 所以必须是「import() 完成后
// 再翻转会话状态」: 两条会话路径都要等块到齐, 渲染直接读模块缓存, 不经 Suspense
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

  it('两条会话路径都等块到齐后才 setUser', () => {
    expect(userSource).toMatch(
      /await Promise\.all\(\[\s*useSettingStore\.persist\.rehydrate\(\),\s*ensureUserDropdownModule\(\)\s*\]\)/
    )
    expect(userSource).toMatch(
      /await Promise\.all\(\[\s*fetchCurrentSession\(\),\s*ensureUserDropdownModule\(\)\s*\]\)/
    )
  })

  it('渲染直接读模块缓存', () => {
    expect(userSource).toMatch(
      /useSyncExternalStore\(\s*subscribeUserDropdown,\s*getUserDropdownModule,\s*getServerUserDropdownModule\s*\)/
    )
    expect(userSource).toContain('<dropdownModule.UserDropdown />')
  })
})
