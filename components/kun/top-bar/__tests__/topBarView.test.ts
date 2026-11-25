import { describe, expect, it } from 'vitest'
import { deriveTopBarView } from '~/components/kun/top-bar/topBarView'
import type { KunTopBarDropdownState } from '~/components/kun/top-bar/topBarView'
import type { KunSessionStatus } from '~/store/userStore'

const view = (
  status: KunSessionStatus,
  {
    isMounted = true,
    isSessionPending = false,
    dropdown = 'ready' as KunTopBarDropdownState
  } = {}
) => deriveTopBarView({ isMounted, isSessionPending, status, dropdown })

// 顶栏右侧只由这个文档判定过的身份决定。曾经的就绪判据拿冻结的首屏 initialSession 与
// store 比 uid, 站内登出或换号后永远不等, 骨架一直转到整页刷新 (P25-01); 之后改成组件里
// 只置真的锁存 (80943200), 现在锁存就是 store 的 status 离开 pending
describe('deriveTopBarView', () => {
  it('判定之前一律骨架: 首帧、Suspense fallback、等会话回查', () => {
    expect(view('pending')).toBe('skeleton')
    expect(view('authenticated', { isMounted: false })).toBe('skeleton')
    expect(view('guest', { isMounted: false })).toBe('skeleton')
    expect(view('authenticated', { isSessionPending: true })).toBe('skeleton')
  })

  it('判定之后随站内登入 / 登出立即切换, 不经过骨架', () => {
    expect(view('authenticated')).toBe('user')
    expect(view('guest')).toBe('guest')
  })

  // 会话写入不等头像菜单的块 (S2b): 块到齐之前已登录也是骨架, 铃铛与头像同帧出现;
  // 游客不需要块; 块加载失败就不再等, 头像位单独留骨架
  it('已登录时等头像菜单的块, 失败了不等', () => {
    expect(view('authenticated', { dropdown: 'loading' })).toBe('skeleton')
    expect(view('authenticated', { dropdown: 'failed' })).toBe('user')
    expect(view('guest', { dropdown: 'loading' })).toBe('guest')
    expect(view('pending', { dropdown: 'ready' })).toBe('skeleton')
  })
})
